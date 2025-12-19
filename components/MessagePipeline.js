import { getEnvBool, getEnvInt } from '../utils/envHotReloader.js';
import { parseSentraResponse } from '../utils/protocolUtils.js';
import { judgeReplySimilarity } from '../utils/replySimilarityJudge.js';

const swallowOnceStateByConversation = new Map();

const SWALLOW_ON_SUPPLEMENT_ENABLED = getEnvBool('SWALLOW_ON_SUPPLEMENT_ENABLED', true);
const SWALLOW_ON_SUPPLEMENT_MAX_WAIT_MS = getEnvInt('SWALLOW_ON_SUPPLEMENT_MAX_WAIT_MS', 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 针对“补充消息”的单次吞吐策略（按会话维度）：
 * - 每个会话在两次真实发送之间，若本次任务期间检测到补充消息，则允许吞掉一次已生成的回复；
 * - 吞掉时仅跳过外发（不调用 smartSend），但仍保留内部对话记录；
 * - 一旦有一次真实发送成功，则重置该会话的吞吐状态；
 * - 受 SWALLOW_ON_SUPPLEMENT_ENABLED / SWALLOW_ON_SUPPLEMENT_MAX_WAIT_MS 控制，可通过 .env 开关与调参。
 */
function shouldSwallowReplyForConversation(conversationId, hasSupplementDuringTask) {
  if (!SWALLOW_ON_SUPPLEMENT_ENABLED || !conversationId || !hasSupplementDuringTask) return false;

  const existing = swallowOnceStateByConversation.get(conversationId);
  if (existing && existing.used) {
    return false;
  }

  swallowOnceStateByConversation.set(conversationId, {
    used: true,
    lastUpdatedAt: Date.now()
  });
  return true;
}

function markReplySentForConversation(conversationId) {
  if (!conversationId) return;
  swallowOnceStateByConversation.delete(conversationId);
}

function normalizeResourceKeys(resources) {
  if (!Array.isArray(resources) || resources.length === 0) return [];
  const keys = [];
  for (const r of resources) {
    if (!r || typeof r !== 'object') continue;
    const type = typeof r.type === 'string' ? r.type.trim() : '';
    const source = typeof r.source === 'string' ? r.source.trim() : '';
    if (!type || !source) continue;
    keys.push(`${type}::${source}`);
  }
  if (!keys.length) return [];
  // 去重并排序，确保集合比较稳定
  return Array.from(new Set(keys)).sort();
}

function areResourceSetsEqual(aResources, bResources) {
  const a = normalizeResourceKeys(aResources);
  const b = normalizeResourceKeys(bResources);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildRewriteRootDirectiveXml(previousResponseXml, candidateResponseXml) {
  const safePrev = (previousResponseXml || '').trim();
  const safeCand = (candidateResponseXml || '').trim();

  const lines = [];
  lines.push('<sentra-root-directive>');
  lines.push('  <id>rewrite_response_v1</id>');
  lines.push('  <type>rewrite</type>');
  lines.push('  <scope>conversation</scope>');
  lines.push(
    '  <objective>在保持事实、数字和结论不变的前提下，对 candidate_response 中的 `<sentra-response>` 做自然语言改写，避免与 original_response 在句子和段落上高度相似。使用不同的句式、结构和过渡，让回复看起来是一次新的表达，而不是简单复读。</objective>'
  );
  lines.push('  <allow_tools>false</allow_tools>');
  lines.push('  <original_response>');
  lines.push('    <![CDATA[');
  if (safePrev) {
    lines.push(safePrev);
  }
  lines.push('    ]]>');
  lines.push('  </original_response>');
  lines.push('  <candidate_response>');
  lines.push('    <![CDATA[');
  if (safeCand) {
    lines.push(safeCand);
  }
  lines.push('    ]]>');
  lines.push('  </candidate_response>');
  lines.push('  <constraints>');
  lines.push(
    '    <item>严格保持事实、数值、时间、地点等信息不变，只改变表达方式、句子结构和组织顺序。</item>'
  );
  lines.push(
    '    <item>你必须只输出一个改写后的 `<sentra-response>`，不要在最终答案中重复输出 original_response 或 candidate_response。</item>'
  );
  lines.push(
    '    <item>避免大段原文复制粘贴，避免仅做单词级的微小同义替换，要通过重组段落、调整描述顺序、使用新的过渡语等方式，真正降低与原回复的文字相似度。</item>'
  );
  lines.push(
    '    <item>保持语言风格和礼貌程度与原回复一致，不要加入与当前对话无关的新事实。</item>'
  );
  lines.push('  </constraints>');
  lines.push('</sentra-root-directive>');
  return lines.join('\n');
}

export async function handleOneMessageCore(ctx, msg, taskId) {
  const {
    logger,
    historyManager,
    timeParser,
    MCP_MAX_CONTEXT_PAIRS,
    CONTEXT_MEMORY_ENABLED,
    getDailyContextMemoryXml,
    personaManager,
    emo,
    buildSentraEmoSection,
    AGENT_PRESET_XML,
    AGENT_PRESET_PLAIN_TEXT,
    AGENT_PRESET_RAW_TEXT,
    baseSystem,
    convertHistoryToMCPFormat,
    buildSentraUserQuestionBlock,
    buildSentraResultBlock,
    smartSend,
    sdk,
    isTaskCancelled,
    trackRunForSender,
    untrackRunForSender,
    chatWithRetry,
    MAIN_AI_MODEL,
    triggerContextSummarizationIfNeeded,
    triggerPresetTeachingIfNeeded,
    clearCancelledTask,
    completeTask,
    startBundleForQueuedMessage,
    collectBundleForSender,
    drainPendingMessagesForSender,
    shouldReply,
    sendAndWaitResult,
    randomUUID,
    saveMessageCache,
    enqueueDelayedJob
  } = ctx;

  const userid = String(msg?.sender_id ?? '');
  const groupId = msg?.group_id ? `G:${msg.group_id}` : `U:${userid}`;
  const currentTaskId = taskId;

  const mergedUsers = Array.isArray(msg?._mergedUsers) ? msg._mergedUsers : null;
  const isMergedGroup = !!msg?._merged && mergedUsers && mergedUsers.length > 1 && msg?.type === 'group';

  const isProactive = !!msg?._proactive;
  const isProactiveFirst = !!msg?._proactiveFirst;
  const proactiveRootXml =
    typeof msg?._sentraRootDirectiveXml === 'string' && msg._sentraRootDirectiveXml.trim()
      ? msg._sentraRootDirectiveXml.trim()
      : null;

  const conversationId = msg?.group_id
    ? `group_${msg.group_id}_sender_${userid}`
    : `private_${userid}`;

  let convId = null;
  let pairId = null;
  let currentUserContent = '';
  let isCancelled = false; // 任务取消标记：检测到新消息时设置为 true
  let hasReplied = false; // 引用控制标记：记录是否已经发送过第一次回复（只有第一次引用消息）
  let hasSupplementDuringTask = false; // 本次任务期间是否检测到补充消息，用于单次吞吐控制
  let endedBySchedule = false; // 当遇到 schedule 延迟任务并成功入队时，提前结束本轮事件循环

  // 从主动 root 指令 XML 中提取 <objective> 文本，用于 MCP 的 objective
  const extractObjectiveFromRoot = (xml) => {
    if (!xml || typeof xml !== 'string') return null;
    const m = xml.match(/<objective>([\s\S]*?)<\/objective>/i);
    if (!m) return null;
    const inner = m[1].trim();
    if (!inner) return null;
    // 压平多行，避免 objective 过长影响日志可读性
    const flat = inner.replace(/\s+/g, ' ').trim();
    return flat ? flat.slice(0, 400) : null;
  };

  try {
    /**
     * 动态感知用户的连续输入和修正
     * 步骤1：将该sender_id的消息从待处理队列移到正在处理队列
     * 这样可以避免任务完成后被误清空，同时能及时感知用户的补充和修正
     */
    await historyManager.startProcessingMessages(groupId, userid);

    /**
     * 步骤2：获取该sender_id在队列中的所有消息（包括待处理和正在处理）
     * 这样bot在处理任务过程中能及时看到用户的补充和修正
     */
    const getAllSenderMessages = () => {
      return historyManager.getPendingMessagesBySender(groupId, userid);
    };

    // 获取该sender_id的所有消息
    let senderMessages = getAllSenderMessages();
    // 主动触发场景下，队列里通常没有待处理消息，此时回退使用当前msg本身
    if (isProactive && (!Array.isArray(senderMessages) || senderMessages.length === 0)) {
      senderMessages = [msg];
    }

    /**
     * 构建拼接内容：将该sender_id的所有消息按时间顺序拼接
     * 让bot能看到完整的任务演变过程（原始请求 -> 修正 -> 补充）
     */
    const buildConcatenatedContent = (messages) => {
      const pickContent = (m) => {
        if (!m) return '';
        const o =
          typeof m.objective === 'string' && m.objective.trim()
            ? m.objective.trim()
            : '';
        const t =
          typeof m.text === 'string' && m.text.trim() ? m.text.trim() : '';
        const s =
          typeof m.summary === 'string' && m.summary.trim()
            ? m.summary.trim()
            : '';
        return o || t || s || '';
      };

      if (messages.length === 0) {
        return pickContent(msg);
      }
      // 拼接所有消息，用换行符分隔，保留时间戳以便bot理解顺序
      return messages
        .map((m) => {
          const timeStr = m.time_str || '';
          const content = pickContent(m);
          return timeStr ? `[${timeStr}] ${content}` : content;
        })
        .filter(Boolean)
        .join('\n\n');
    };

    // objective: 主动场景优先使用 root 指令中的 <objective>，否则回退为用户消息拼接
    // 确保 bot 在所有阶段都能看到清晰的“本轮意图”，而不是简单重复上一条用户文本
    let userObjective;
    if (isMergedGroup) {
      const mergedLines = [];
      mergedUsers.forEach((u, idx) => {
        if (!u) return;
        const name = (u.sender_name || u.nickname || `User${idx + 1}`).trim();
        const raw = u.raw || {};
        const baseText =
          (typeof u.text === 'string' && u.text.trim()) ||
          (typeof raw.objective === 'string' && raw.objective.trim()) ||
          (typeof raw.text === 'string' && raw.text.trim()) ||
          (typeof raw.summary === 'string' && raw.summary.trim()) ||
          '';
        if (!baseText) return;
        mergedLines.push(name ? `${name}: ${baseText}` : baseText);
      });
      const mergedText = mergedLines.join('\n\n');
      userObjective = mergedText || buildConcatenatedContent(senderMessages);
    } else if (isProactive && proactiveRootXml) {
      userObjective = extractObjectiveFromRoot(proactiveRootXml) || buildConcatenatedContent(senderMessages);
    } else {
      userObjective = buildConcatenatedContent(senderMessages);
    }

    // conversation: 构建 MCP FC 协议格式的对话上下文
    // 包含：1. 历史工具调用上下文 2. 当前用户消息（使用 Sentra XML 块，而非 summary 文本）
    // 使用聚合后的最终用户输入（msg）进行时间解析：若文本包含时间表达式，则优先选取该时间段内的历史对话，再合并最近若干对话
    const timeText = (msg?.text || msg?.summary || '').trim();

    const contextPairsLimit =
      Number.isFinite(MCP_MAX_CONTEXT_PAIRS) && MCP_MAX_CONTEXT_PAIRS > 0
        ? MCP_MAX_CONTEXT_PAIRS
        : historyManager.maxConversationPairs || 20;

    let historyConversations = historyManager.getConversationHistoryForContext(groupId, {
      recentPairs: contextPairsLimit
    });
    try {
      if (timeText) {
        const hasTime = timeParser.containsTimeExpression(timeText, { language: 'zh-cn' });
        if (hasTime) {
          logger.info(`检测到时间表达式，尝试按时间窗口筛选历史: ${timeText}`);
          const parsedTime = timeParser.parseTimeExpression(timeText, {
            language: 'zh-cn',
            timezone: 'Asia/Shanghai'
          });
          if (parsedTime && parsedTime.success && parsedTime.windowTimestamps) {
            const { start, end } = parsedTime.windowTimestamps;
            const fmtStart = parsedTime.windowFormatted?.start || new Date(start).toISOString();
            const fmtEnd = parsedTime.windowFormatted?.end || new Date(end).toISOString();
            const enhancedHistory = historyManager.getConversationHistoryForContext(groupId, {
              timeStart: start,
              timeEnd: end,
              recentPairs: contextPairsLimit
            });
            if (Array.isArray(enhancedHistory)) {
              if (enhancedHistory.length > 0) {
                historyConversations = enhancedHistory;
                logger.info(
                  `时间窗口命中: ${groupId} window [${fmtStart} - ${fmtEnd}], 使用筛选后的历史${historyConversations.length}条 (limit=${contextPairsLimit})`
                );
              } else {
                logger.info(
                  `时间窗口内未找到历史对话: ${groupId} window [${fmtStart} - ${fmtEnd}], 保持原有历史${historyConversations.length}条 (limit=${contextPairsLimit})`
                );
              }
            }
          } else {
            logger.info(`时间解析未成功，保持原有历史: ${groupId}`);
          }
        } else {
          logger.debug(`未检测到时间表达式: ${groupId} text="${timeText}"`);
        }
      }
    } catch (e) {
      logger.warn(`时间解析或历史筛选失败: ${groupId}`, { err: String(e) });
    }

    // 主动回合的后续自我延展：仅依赖 root 指令 + 系统摘要，不再注入逐条对话历史，避免过度黏着用户最近话题
    const effectiveHistoryConversations = isProactive && !isProactiveFirst ? [] : historyConversations;

    const mcpHistory = convertHistoryToMCPFormat(effectiveHistoryConversations);

    // 复用构建逻辑：pending-messages（如果有） + sentra-user-question（当前消息）
    const latestMsg = senderMessages[senderMessages.length - 1] || msg;

    if (isProactive && !isProactiveFirst) {
      // 后续主动回合：仅依赖 root 指令和系统上下文，不再重新注入用户问题
      currentUserContent = proactiveRootXml || '';
    } else {
      const pendingContextXml = historyManager.getPendingMessagesContext(groupId, userid);
      const baseUserMsg = isMergedGroup ? msg : latestMsg;
      const userQuestionXml = buildSentraUserQuestionBlock(baseUserMsg);
      const combinedUserContent = pendingContextXml
        ? pendingContextXml + '\n\n' + userQuestionXml
        : userQuestionXml;
      currentUserContent = proactiveRootXml
        ? `${proactiveRootXml}\n\n${combinedUserContent}`
        : combinedUserContent;
    }

    const conversation = [
      ...mcpHistory, // 历史上下文（user 的 sentra-user-question + assistant 的 sentra-tools），仅在需要时保留
      { role: 'user', content: currentUserContent } // 当前任务（XML 块）
    ];

    //console.log(JSON.stringify(conversation, null, 2))
    logger.debug(
      `MCP上下文: ${groupId} 使用历史${effectiveHistoryConversations.length}条 (limit=${contextPairsLimit}) → 转换后${mcpHistory.length}条 + 当前1条 = 总计${conversation.length}条`
    );
    try {
      const totalConv = conversation.length;
      const previewLimit = 500000;
      const convPreview = totalConv > previewLimit ? conversation.slice(0, previewLimit) : conversation;
      logger.debug(
        `MCP上下文messages预览(${convPreview.length}/${totalConv}条): ${JSON.stringify(convPreview)}`
      );
    } catch (e) {
      logger.debug(`MCP上下文messages预览序列化失败: ${String(e)}`);
    }
    // 获取用户画像（如果启用）
    let personaContext = '';
    if (personaManager && userid) {
      personaContext = personaManager.formatPersonaForContext(userid);
      if (personaContext) {
        logger.debug(`用户画像: ${userid} 画像已加载`);
      }
    }

    // 获取近期情绪（用于 <sentra-emo>）
    let emoXml = '';
    try {
      if (userid) {
        const ua = await emo.userAnalytics(userid, { days: 7 });
        emoXml = buildSentraEmoSection(ua);
      }
    } catch {}

    const agentPresetXml = AGENT_PRESET_XML || '';

    // 组合系统提示词：baseSystem + persona + emo + memory + agent-preset(最后)
    let memoryXml = '';
    if (CONTEXT_MEMORY_ENABLED) {
      try {
        memoryXml = await getDailyContextMemoryXml(groupId);
        if (memoryXml) {
          logger.debug(`上下文记忆: ${groupId} 已加载当日摘要`);
        }
      } catch (e) {
        logger.debug(`上下文记忆加载失败: ${groupId}`, { err: String(e) });
      }
    }

    const systemParts = [baseSystem, personaContext, emoXml, memoryXml, agentPresetXml].filter(Boolean);
    const systemContent = systemParts.join('\n\n');

    const maybeRewriteSentraResponse = async (rawResponse) => {
      try {
        if (!rawResponse || typeof rawResponse !== 'string') return null;

        if (
          !historyManager ||
          typeof historyManager.getLastAssistantMessageContent !== 'function'
        ) {
          return null;
        }

        const previousContent = historyManager.getLastAssistantMessageContent(groupId);
        if (!previousContent || typeof previousContent !== 'string') {
          return null;
        }

        let prevParsed;
        let currParsed;
        try {
          prevParsed = parseSentraResponse(previousContent);
          currParsed = parseSentraResponse(rawResponse);
        } catch (e) {
          logger.debug('ReplyRewrite: parseSentraResponse 失败，跳过重写', {
            err: String(e)
          });
          return null;
        }

        const prevTextSegments = Array.isArray(prevParsed.textSegments)
          ? prevParsed.textSegments
          : [];
        const currTextSegments = Array.isArray(currParsed.textSegments)
          ? currParsed.textSegments
          : [];

        const prevText = prevTextSegments.join('\n\n').trim();
        const currText = currTextSegments.join('\n\n').trim();

        if (!prevText || !currText) {
          return null;
        }

        // 资源集合必须完全一致，才认为是“同一条消息下的复读”，否则视为不同内容
        const resourcesEqual = areResourceSetsEqual(prevParsed.resources, currParsed.resources);
        if (!resourcesEqual) {
          return null;
        }

        const sim = await judgeReplySimilarity(prevText, currText);
        if (!sim || !sim.areSimilar) {
          return null;
        }

        logger.info('ReplyRewrite: 检测到与最近一次回复高度相似，尝试触发重写', {
          groupId,
          similarity: sim.similarity,
          source: sim.source
        });

        const rootXml = buildRewriteRootDirectiveXml(previousContent, rawResponse);
        const convForRewrite = [
          { role: 'system', content: systemContent },
          { role: 'user', content: rootXml }
        ];

        const rewriteResult = await chatWithRetry(convForRewrite, MAIN_AI_MODEL, groupId);
        if (!rewriteResult || !rewriteResult.success || !rewriteResult.response) {
          logger.warn('ReplyRewrite: 重写调用失败，将回退使用原始回复', {
            reason: rewriteResult?.reason || 'unknown'
          });
          return null;
        }

        const rewritten = rewriteResult.response;

        let parsedRewritten;
        try {
          parsedRewritten = parseSentraResponse(rewritten);
        } catch (e) {
          logger.warn('ReplyRewrite: 重写结果解析失败，将回退使用原始回复', {
            err: String(e)
          });
          return null;
        }

        const rewrittenTextSegments = Array.isArray(parsedRewritten.textSegments)
          ? parsedRewritten.textSegments
          : [];
        const rewrittenText = rewrittenTextSegments.join('\n\n').trim();

        if (parsedRewritten.shouldSkip || !rewrittenText) {
          logger.warn('ReplyRewrite: 重写结果为空或被标记为 shouldSkip，放弃重写');
          return null;
        }

        // 可选：再做一次相似度检查，避免“改写”后仍然高度相似
        try {
          const simAfter = await judgeReplySimilarity(prevText, rewrittenText);
          if (
            simAfter &&
            simAfter.areSimilar &&
            simAfter.similarity != null &&
            (sim.similarity == null || simAfter.similarity >= sim.similarity)
          ) {
            logger.info('ReplyRewrite: 重写后与上一轮仍高度相似，将回退原始回复', {
              similarityBefore: sim.similarity,
              similarityAfter: simAfter.similarity
            });
            return null;
          }
        } catch {}

        logger.info('ReplyRewrite: 重写成功，将使用改写后的回复替代原始回复');
        return rewritten;
      } catch (e) {
        logger.warn('ReplyRewrite: 执行重写逻辑时出现异常，跳过重写', {
          err: String(e)
        });
        return null;
      }
    };

    let conversations = [{ role: 'system', content: systemContent }, ...historyConversations];
    const baseGlobalOverlay = AGENT_PRESET_PLAIN_TEXT || AGENT_PRESET_RAW_TEXT || '';
    let overlays;
    if (isProactive) {
      overlays = {
        global: baseGlobalOverlay,
        plan:
          '本轮为由 <sentra-root-directive type="proactive"> 标记的主动发言，请以 root directive 中的 objective 为最高准则，优先规划能够引出“新视角/新子话题”的步骤，可以合理使用各类 MCP 工具（搜索、网页解析、天气/时间、音乐/图片/视频、文档/代码、思维导图等）先获取真实信息或可分享素材，再结合 Bot 人设组织分享或提问，避免仅安排继续解释当前问题或重复提醒。',
        arggen:
          '当为主动回合生成工具参数时，优先选择那些能够为用户带来具体可观察结果的工具（例如搜索结果、网页摘要、图片/视频/音乐卡片、天气/实时信息等），并将参数控制在一次轻量查询或生成的范围内，避免过度复杂的多轮采集或无关查询。',
        judge:
          '在审核候选计划时，优先选择那些能够通过工具获得具体信息或可视化内容、并围绕当前语境提出新问题或补充背景的方案；对于仅包含“继续解释当前问题”或没有任何工具调用、且缺乏新意的计划，应认为不合格，并允许最终保持沉默。',
        final_judge:
          '在最终评估主动回复时，请检查内容是否真正带来了新的信息、视角或轻度转场，而不是复述之前的回答；若回复仅为很短且空泛的客套话（例如简单的“哈哈”“不错哦”等）或对已有解答的轻微改写，应倾向设置 noReply=true 或大幅压缩内容，对于主动回合，保持沉默优于输出低价值内容。'
      };
    } else {
      overlays = { global: baseGlobalOverlay };
    }
    const sendAndWaitWithConv = (m) => {
      const mm = m || {};
      if (!mm.requestId) {
        try {
          mm.requestId = `${convId || randomUUID()}:${randomUUID()}`;
        } catch {
          mm.requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        }
      }
      return sendAndWaitResult(mm);
    };

    // 记录初始消息数量
    const initialMessageCount = senderMessages.length;

    // 在 Judge / ToolResult 最终发送前，按需做一次额外静默等待：
    // - 若在 SWALLOW_ON_SUPPLEMENT_MAX_WAIT_MS 时间内检测到新消息，则标记 hasSupplementDuringTask=true，触发单次吞吐逻辑；
    // - 若未检测到新消息，则直接发送当前结果，避免无限等待。
    const maybeWaitForSupplementBeforeSend = async () => {
      if (!SWALLOW_ON_SUPPLEMENT_ENABLED || SWALLOW_ON_SUPPLEMENT_MAX_WAIT_MS <= 0) {
        return;
      }

      const baseMessages = getAllSenderMessages();
      const baseCount = Array.isArray(baseMessages) ? baseMessages.length : 0;

      // 若此时已经出现补充消息，则无需额外等待，直接让吞吐策略生效
      if (baseCount > initialMessageCount) {
        hasSupplementDuringTask = true;
        ctx.logger.info(
          `补充消息静默等待: ${groupId} 发送前已存在补充消息 ${initialMessageCount} -> ${baseCount}，无需额外等待`
        );
        return;
      }

      const maxWait = SWALLOW_ON_SUPPLEMENT_MAX_WAIT_MS;
      const pollInterval = Math.min(500, Math.max(100, Math.floor(maxWait / 5)));
      const startWaitAt = Date.now();
      ctx.logger.debug(
        `补充消息静默等待: ${groupId} 最多等待 ${maxWait}ms 观察是否有新消息 (base=${baseCount})`
      );

      while (Date.now() - startWaitAt < maxWait) {
        if (currentTaskId && isTaskCancelled(currentTaskId)) {
          ctx.logger.info(`任务已取消: ${groupId} 结束发送前静默等待`);
          return;
        }

        await sleep(pollInterval);

        const latest = getAllSenderMessages();
        const latestCount = Array.isArray(latest) ? latest.length : 0;
        if (latestCount > baseCount) {
          hasSupplementDuringTask = true;
          ctx.logger.info(
            `补充消息静默等待: ${groupId} 等待期间检测到新消息 ${baseCount} -> ${latestCount}，触发吞吐条件`
          );
          return;
        }
      }

      ctx.logger.debug(
        `补充消息静默等待: ${groupId} 等待 ${Date.now() - startWaitAt}ms 内未检测到新消息，直接发送`
      );
    };

    for await (const ev of sdk.stream({
      objective: userObjective,
      conversation: conversation,
      overlays
    })) {
      logger.debug('Agent事件', ev);

      if (currentTaskId && isTaskCancelled(currentTaskId)) {
        isCancelled = true;
        logger.info(`检测到任务已被取消: ${groupId} taskId=${currentTaskId}`);
        break;
      }

      // 在 start 事件时缓存消息 - 缓存最后一条待回复消息
      if (ev.type === 'start' && ev.runId) {
        // 记录 runId 和会话，用于后续在“改主意”场景下仅取消本会话下的运行
        trackRunForSender(userid, groupId, ev.runId);

        // 实时获取最新的消息列表
        senderMessages = getAllSenderMessages();

        // 保存消息缓存（用于插件通过 runId 反查 user_id / group_id 等上下文）
        if (typeof saveMessageCache === 'function') {
          try {
            const cacheMsg = senderMessages[senderMessages.length - 1] || msg;
            await saveMessageCache(ev.runId, cacheMsg);
          } catch (e) {
            logger.debug(`保存消息缓存失败: ${groupId} runId=${ev.runId}`, { err: String(e) });
          }
        }

        // 检查是否有新消息到达
        if (senderMessages.length > initialMessageCount) {
          hasSupplementDuringTask = true;
          logger.info(
            `动态感知: ${groupId} 检测到新消息 ${initialMessageCount} -> ${senderMessages.length}，将更新上下文`
          );
        }
      }

      if (ev.type === 'judge') {
        if (!convId) convId = randomUUID();
        if (!ev.need) {
          // 开始构建 Bot 回复
          pairId = await historyManager.startAssistantMessage(groupId);
          logger.debug(`创建pairId-Judge: ${groupId} pairId ${pairId?.substring(0, 8)}`);

          // 实时获取最新的sender消息列表
          senderMessages = getAllSenderMessages();

          // 检查是否有新消息：如果有，需要拼接所有消息作为上下文
          if (senderMessages.length > initialMessageCount) {
            logger.info(`动态感知Judge: ${groupId} 检测到新消息，拼接完整上下文`);
          }

          const latestMsgJudge = senderMessages[senderMessages.length - 1] || msg;

          let judgeBaseContent;
          if (isProactive && !isProactiveFirst) {
            // 后续主动回合：不再围绕最近用户消息构造 user-question，仅使用 root 指令
            judgeBaseContent = '';
            currentUserContent = proactiveRootXml || '';
          } else {
            // 获取历史上下文（仅供参考，只包含该 sender 的历史消息）
            const contextXml = historyManager.getPendingMessagesContext(groupId, userid);
            // 构建当前需要回复的消息（主要内容）- 使用最新的消息
            const userQuestion = buildSentraUserQuestionBlock(latestMsgJudge);

            // 组合上下文：历史上下文 + 当前消息
            if (contextXml) {
              judgeBaseContent = contextXml + '\n\n' + userQuestion;
            } else {
              judgeBaseContent = userQuestion;
            }

            currentUserContent = proactiveRootXml
              ? `${proactiveRootXml}\n\n${judgeBaseContent}`
              : judgeBaseContent;
          }

          // Judge 判定无需工具：为当前对话显式注入占位工具与结果，便于后续模型判断
          try {
            const rawReason =
              (typeof latestMsgJudge?.objective === 'string' &&
                latestMsgJudge.objective.trim()) ||
              (typeof latestMsgJudge?.summary === 'string' &&
                latestMsgJudge.summary.trim()) ||
              (typeof latestMsgJudge?.text === 'string' &&
                latestMsgJudge.text.trim()) ||
              'No tool required for this message.';
            const reasonText = rawReason.trim();
            const toolsXML = [
              '<sentra-tools>',
              '  <invoke name="none">',
              '    <parameter name="no_tool">true</parameter>',
              `    <parameter name="reason">${reasonText}</parameter>`,
              '  </invoke>',
              '</sentra-tools>'
            ].join('\n');

            const evNoTool = {
              type: 'tool_result',
              aiName: 'none',
              plannedStepIndex: 0,
              reason: reasonText,
              result: {
                success: true,
                code: 'NO_TOOL',
                provider: 'system',
                data: { no_tool: true, reason: reasonText }
              }
            };
            const resultXML = buildSentraResultBlock(evNoTool);
            // 将占位工具+结果置于最前，保持与工具路径一致的上下文结构
            currentUserContent = toolsXML + '\n\n' + resultXML + '\n\n' + currentUserContent;
          } catch {}

          conversations.push({ role: 'user', content: currentUserContent });
          // logger.debug('Conversations', conversations);
          //console.log(JSON.stringify(conversations, null, 2))
          const result = await chatWithRetry(conversations, MAIN_AI_MODEL, groupId);

          if (!result.success) {
            logger.error(
              `AI响应失败Judge: ${groupId} 原因 ${result.reason}, 重试${result.retries}次`
            );
            if (pairId) {
              logger.debug(
                `取消pairId-Judge失败: ${groupId} pairId ${pairId.substring(0, 8)}`
              );
              await historyManager.cancelConversationPairById(groupId, pairId);
              pairId = null;
            }
            return;
          }

          let response = result.response;
          const noReply = !!result.noReply;
          logger.success(`AI响应成功Judge: ${groupId} 重试${result.retries}次`);

          const rewrittenJudge = await maybeRewriteSentraResponse(response);
          if (rewrittenJudge && typeof rewrittenJudge === 'string') {
            response = rewrittenJudge;
          }

          let parsedJudgeForPromise = null;
          try {
            parsedJudgeForPromise = parseSentraResponse(response);
          } catch (e) {
            logger.debug('PromiseMeta: parseSentraResponse 失败，跳过承诺检测', {
              err: String(e)
            });
          }

          await historyManager.appendToAssistantMessage(groupId, response, pairId);

          const latestSenderMessages = getAllSenderMessages();
          if (latestSenderMessages.length > initialMessageCount) {
            hasSupplementDuringTask = true;
            logger.info(
              `动态感知Judge: ${groupId} 检测到补充消息 ${initialMessageCount} -> ${latestSenderMessages.length}，整合到上下文`
            );
          }

          if (isCancelled) {
            logger.info(`任务已取消: ${groupId} 跳过发送Judge阶段`);
            return;
          }

          if (!noReply) {
            await maybeWaitForSupplementBeforeSend();

            senderMessages = getAllSenderMessages();
            const finalMsg = senderMessages[senderMessages.length - 1] || msg;
            const allowReply = true;

            const swallow = shouldSwallowReplyForConversation(conversationId, hasSupplementDuringTask);
            if (swallow) {
              logger.info(
                `补充消息吞吐策略: ${groupId} 本轮Judge阶段检测到补充消息，跳过外发，仅保留内部对话记录 (conversation=${conversationId})`
              );
            } else {
              logger.debug(
                `引用消息Judge: ${groupId} 消息${finalMsg.message_id}, sender ${finalMsg.sender_id}, 队列${senderMessages.length}条, 允许引用 ${allowReply}`
              );
              await smartSend(finalMsg, response, sendAndWaitWithConv, allowReply, { hasTool: false });
              hasReplied = true;
              if (ctx.desireManager) {
                try {
                  await ctx.desireManager.onBotMessage(finalMsg, { proactive: !!msg?._proactive });
                } catch (e) {
                  logger.debug('DesireManager onBotMessage(Judge) failed', { err: String(e) });
                }
              }

              if (
                parsedJudgeForPromise &&
                parsedJudgeForPromise.promise &&
                parsedJudgeForPromise.promise.hasPromise === true &&
                parsedJudgeForPromise.promise.objective &&
                typeof enqueueDelayedJob === 'function'
              ) {
                try {
                  const delayRaw = getEnvInt('PROMISE_FULFILL_INITIAL_DELAY_MS', 15000);
                  const delayMs =
                    Number.isFinite(delayRaw) && delayRaw >= 0 ? delayRaw : 15000;
                  const promiseObjective = String(
                    parsedJudgeForPromise.promise.objective || ''
                  ).trim();
                  if (promiseObjective) {
                    const job = {
                      jobId: randomUUID(),
                      aiName: '__promise_fulfill__',
                      userId: userid,
                      groupId: msg?.group_id || null,
                      type: msg?.type || (msg?.group_id ? 'group' : 'private'),
                      reason: promiseObjective,
                      promiseObjective,
                      createdAt: Date.now(),
                      fireAt: Date.now() + delayMs,
                      attempt: 0,
                      lastMsg: finalMsg
                    };
                    await enqueueDelayedJob(job);
                  }
                } catch (e) {
                  logger.debug('PromiseMeta: 入队承诺补单任务失败', { err: String(e) });
                }
              }

              markReplySentForConversation(conversationId);
            }
          } else {
            logger.info(`Judge 阶段: 模型选择保持沉默 (noReply=true)，跳过发送`);
          }

          const saved = await historyManager.finishConversationPair(
            groupId,
            pairId,
            currentUserContent
          );

          if (saved) {
            const chatType = msg?.group_id ? 'group' : 'private';
            const userIdForMemory = userid || '';
            triggerContextSummarizationIfNeeded({ groupId, chatType, userId: userIdForMemory }).catch(
              (e) => {
                logger.debug(`ContextMemory: 异步摘要触发失败 ${groupId}`, { err: String(e) });
              }
            );
            triggerPresetTeachingIfNeeded({
              groupId,
              chatType,
              userId: userIdForMemory,
              userContent: currentUserContent,
              assistantContent: response
            }).catch((e) => {
              logger.debug(`PresetTeaching: 异步教导触发失败 ${groupId}`, { err: String(e) });
            });
          }

          pairId = null;
          return;
        }
      }

      if (ev.type === 'plan') {
        logger.info('执行计划', ev.plan.steps);
      }

      // 忽略 args/args_group 事件（只对 tool_result/_group + 进度/日程确认 做回复）
      if (ev.type === 'args' || ev.type === 'args_group') {
        continue;
      }

      // Schedule 延迟机制：
      // - status = 'scheduled'  表示已成功解析并设置 schedule，触发一条“定时任务已创建”的普通回复；
      // - status = 'in_progress' 表示到达 delayMs 时工具尚未完成，触发一条“任务仍在执行中的进度”回复；
      // 这两类事件都被包装为虚拟工具 schedule_progress 的 <sentra-result>，再通过主模型生成最终自然语言回复，
      // 与普通 tool_result 路径保持一致（同样走 chatWithRetry + <sentra-response> 流程），不直接发送底层 message 文本。
      if (
        ev.type === 'tool_choice' &&
        (ev.status === 'in_progress' || ev.status === 'scheduled')
      ) {
        const isScheduled = ev.status === 'scheduled';
        try {
          const senderMsgsNow = getAllSenderMessages();
          const latestMsgProgress = senderMsgsNow[senderMsgsNow.length - 1] || msg;

          let progressBaseContent = '';
          if (isProactive && !isProactiveFirst) {
            progressBaseContent = proactiveRootXml || '';
          } else {
            const contextXml = historyManager.getPendingMessagesContext(groupId, userid);
            const userQuestion = buildSentraUserQuestionBlock(latestMsgProgress);
            if (contextXml) {
              progressBaseContent = contextXml + '\n\n' + userQuestion;
            } else {
              progressBaseContent = userQuestion;
            }
            if (proactiveRootXml) {
              progressBaseContent = `${proactiveRootXml}\n\n${progressBaseContent}`;
            }
          }

          if (isScheduled && typeof enqueueDelayedJob === 'function') {
            try {
              const baseArgs = ev.args && typeof ev.args === 'object' ? { ...ev.args } : {};
              if (Object.prototype.hasOwnProperty.call(baseArgs, 'schedule')) {
                delete baseArgs.schedule;
              }

              const delayMs = Number.isFinite(ev.delayMs) ? ev.delayMs : Number(ev.delayMs || 0) || 0;
              let fireAt = 0;
              if (ev.schedule && ev.schedule.targetISO) {
                const ts = Date.parse(ev.schedule.targetISO);
                if (Number.isFinite(ts) && ts > 0) {
                  fireAt = ts;
                }
              }
              if (!fireAt) {
                fireAt = Date.now() + Math.max(0, delayMs);
              }

              const scheduleMode = ev.scheduleMode || (ev.schedule && ev.schedule.mode) || undefined;

              const job = {
                jobId: randomUUID(),
                runId: ev.runId || null,
                aiName: ev.aiName,
                args: baseArgs,
                schedule: ev.schedule || null,
                delayMs,
                scheduleMode,
                plannedStepIndex: typeof ev.stepIndex === 'number' ? ev.stepIndex : 0,
                // 基础身份信息：用于在缓存缺失时仍可回退到合理的上下文
                userId: userid,
                groupId: msg?.group_id || null,
                type: msg?.type || (msg?.group_id ? 'group' : 'private'),
                // 人类可读原因：供延迟任务到期时作为上下文摘要
                reason:
                  ev.reason ||
                  (ev.schedule && ev.schedule.text
                    ? `定时执行 ${ev.schedule.text}`
                    : '延迟任务到期自动执行'),
                createdAt: Date.now(),
                fireAt
              };

              await enqueueDelayedJob(job);

              const mode = scheduleMode || 'delayed_exec';
              if (mode === 'delayed_exec' && sdk && typeof sdk.cancelRun === 'function' && ev.runId) {
                try {
                  sdk.cancelRun(ev.runId);
                  try {
                    untrackRunForSender(userid, groupId, ev.runId);
                  } catch {}
                } catch (e) {
                  logger.debug('取消延迟任务对应的 MCP run 失败', {
                    groupId,
                    runId: ev.runId,
                    err: String(e)
                  });
                }
              }
            } catch (e) {
              logger.warn('入队延迟任务失败，将继续按普通进度事件处理', {
                err: String(e)
              });
            }
          }

          const progressEv = {
            type: 'tool_result',
            aiName: 'schedule_progress',
            plannedStepIndex: typeof ev.stepIndex === 'number' ? ev.stepIndex : 0,
            executionIndex: -1,
            reason:
              ev.reason ||
              (isScheduled
                ? '任务已成功设置定时执行'
                : 'Scheduled tool is still running'),
            nextStep: '',
            args: {
              original_aiName: ev.aiName,
              status: ev.status,
              elapsedMs: ev.elapsedMs,
              delayMs: ev.delayMs,
              schedule: ev.schedule
            },
            result: {
              success: true,
              code: isScheduled ? 'SCHEDULED' : 'IN_PROGRESS',
              provider: 'system',
              data: {
                // 正在执行的真实 MCP 工具
                original_aiName: ev.aiName,
                // 进度类型：schedule_ack / delay_progress
                kind: isScheduled ? 'schedule_ack' : 'delay_progress',
                status: ev.status,
                // 延迟与耗时信息
                delayMs: ev.delayMs,
                elapsedMs: ev.elapsedMs,
                // 解析后的日程信息，供主模型按 MCP 语义理解
                schedule_text: ev.schedule?.text,
                schedule_targetISO: ev.schedule?.targetISO,
                schedule_timezone: ev.schedule?.timezone
              }
            },
            elapsedMs: ev.elapsedMs || 0,
            dependsOn: [],
            dependedBy: [],
            groupId: null,
            groupSize: 1,
            toolMeta: { provider: 'system' }
          };

          let progressContent = '';
          try {
            progressContent = buildSentraResultBlock(progressEv);
          } catch (e) {
            logger.warn('构建 <sentra-result> 失败，回退 JSON 注入');
            progressContent = JSON.stringify(progressEv);
          }

          const fullUserContent = progressBaseContent
            ? progressContent + '\n\n' + progressBaseContent
            : progressContent;

          const progressPairId = await historyManager.startAssistantMessage(groupId);

          // 使用与普通 tool_result 相同的主逻辑：
          // 将 schedule_progress 结果 + 用户上下文 作为一条新的 user 消息送入 MAIN_AI_MODEL，
          // 由模型生成最终要发送给用户的自然语言回复。
          const convForSchedule = [
            ...conversations,
            { role: 'user', content: fullUserContent }
          ];

          const scheduleResult = await chatWithRetry(
            convForSchedule,
            MAIN_AI_MODEL,
            groupId
          );

          if (!scheduleResult.success) {
            logger.error(
              `AI响应失败ScheduleProgress: ${groupId} 原因 ${scheduleResult.reason}, 重试${scheduleResult.retries}次`
            );
            try {
              await historyManager.cancelConversationPairById(groupId, progressPairId);
            } catch (e) {
              logger.debug('取消pairId-ScheduleProgress失败', {
                groupId,
                err: String(e)
              });
            }
            continue;
          }

          const scheduleResponse = scheduleResult.response;
          const scheduleNoReply = !!scheduleResult.noReply;

          await historyManager.appendToAssistantMessage(
            groupId,
            scheduleResponse,
            progressPairId
          );

          const savedProgress = await historyManager.finishConversationPair(
            groupId,
            progressPairId,
            fullUserContent
          );
          if (!savedProgress) {
            logger.warn(
              `保存进度对话对失败: ${groupId} pairId ${String(progressPairId).substring(0, 8)}`
            );
          }

          if (!scheduleNoReply) {
            const latestSenderMessages = getAllSenderMessages();
            const finalMsgProgress =
              latestSenderMessages[latestSenderMessages.length - 1] || msg;
            const allowReplyProgress = true;

            await smartSend(
              finalMsgProgress,
              scheduleResponse,
              sendAndWaitWithConv,
              allowReplyProgress,
              { hasTool: true }
            );
            hasReplied = true;
            if (ctx.desireManager) {
              try {
                await ctx.desireManager.onBotMessage(finalMsgProgress, {
                  proactive: !!msg?._proactive
                });
              } catch (e) {
                logger.debug('DesireManager onBotMessage(ToolProgress) failed', {
                  err: String(e)
                });
              }
            }
            markReplySentForConversation(conversationId);
          } else {
            logger.info(
              `ScheduleProgress 阶段: 模型选择保持沉默 (noReply=true)，跳过发送`
            );
          }
        } catch (e) {
          logger.warn('处理 Schedule 延迟进度事件失败，将忽略本次中间状态', {
            err: String(e)
          });
        }
        if (isScheduled) {
          endedBySchedule = true;
          break;
        }
        continue;
      }

      if (ev.type === 'tool_result' || ev.type === 'tool_result_group') {
        if (!pairId) {
          pairId = await historyManager.startAssistantMessage(groupId);
          logger.debug(`创建pairId-ToolResult: ${groupId} pairId ${pairId?.substring(0, 8)}`);
        }

        if (!currentUserContent) {
          senderMessages = getAllSenderMessages();

          if (senderMessages.length > initialMessageCount) {
            logger.info(
              `动态感知ToolResult: ${groupId} 检测到新消息，拼接完整上下文`
            );
          }

          const latestMsgTool = senderMessages[senderMessages.length - 1] || msg;

          if (isProactive && !isProactiveFirst) {
            // 后续主动回合：仅基于 root 指令和工具结果做总结，不重新注入用户问题
            currentUserContent = proactiveRootXml || '';
          } else {
            // 获取该 sender 的历史上下文
            const contextXml = historyManager.getPendingMessagesContext(groupId, userid);
            const userQuestion = buildSentraUserQuestionBlock(latestMsgTool);

            let toolBaseContent;
            if (contextXml) {
              toolBaseContent = contextXml + '\n\n' + userQuestion;
            } else {
              toolBaseContent = userQuestion;
            }

            currentUserContent = proactiveRootXml
              ? `${proactiveRootXml}\n\n${toolBaseContent}`
              : toolBaseContent;
          }
        }

        // 构建结果观测块
        let content = '';
        try {
          content = buildSentraResultBlock(ev);
        } catch (e) {
          logger.warn('构建 <sentra-result> 失败，回退 JSON 注入');
          content = JSON.stringify(ev);
        }

        const fullContext = content + '\n\n' + currentUserContent;

        // 更新 currentUserContent 为包含工具结果的完整上下文，确保保存到历史记录时不丢失工具结果
        currentUserContent = fullContext;

        conversations.push({ role: 'user', content: fullContext });
        //console.log(JSON.stringify(conversations, null, 2))
        const result = await chatWithRetry(conversations, MAIN_AI_MODEL, groupId);

        if (!result.success) {
          logger.error(
            `AI响应失败ToolResult: ${groupId} 原因 ${result.reason}, 重试${result.retries}次`
          );
          if (pairId) {
            logger.debug(
              `取消pairId-ToolResult失败: ${groupId} pairId ${pairId.substring(0, 8)}`
            );
            await historyManager.cancelConversationPairById(groupId, pairId);
            pairId = null;
          }
          return;
        }

        let response = result.response;
        const noReply = !!result.noReply;
        logger.success(`AI响应成功ToolResult: ${groupId} 重试${result.retries}次`);

        const rewrittenTool = await maybeRewriteSentraResponse(response);
        if (rewrittenTool && typeof rewrittenTool === 'string') {
          response = rewrittenTool;
        }

        await historyManager.appendToAssistantMessage(groupId, response, pairId);

        const latestSenderMessages = getAllSenderMessages();
        if (latestSenderMessages.length > initialMessageCount) {
          hasSupplementDuringTask = true;
          logger.info(
            `动态感知ToolResult: ${groupId} 检测到补充消息 ${initialMessageCount} -> ${latestSenderMessages.length}，整合到上下文`
          );
        }

        if (isCancelled) {
          logger.info(`任务已取消: ${groupId} 跳过发送ToolResult阶段`);
          return;
        }

        if (!noReply) {
          await maybeWaitForSupplementBeforeSend();

          const latestSenderMessagesForSend = getAllSenderMessages();
          const finalMsgTool =
            latestSenderMessagesForSend[latestSenderMessagesForSend.length - 1] || msg;
          const allowReplyTool = true;

          const swallow = shouldSwallowReplyForConversation(
            conversationId,
            hasSupplementDuringTask
          );
          if (swallow) {
            logger.info(
              `补充消息吞吐策略: ${groupId} 本轮ToolResult阶段检测到补充消息，跳过外发，仅保留内部对话记录 (conversation=${conversationId})`
            );
          } else {
            logger.debug(
              `引用消息ToolResult: ${groupId} 消息${finalMsgTool.message_id}, sender ${finalMsgTool.sender_id}, 队列${latestSenderMessagesForSend.length}条, 允许引用 ${allowReplyTool}`
            );
            await smartSend(
              finalMsgTool,
              response,
              sendAndWaitWithConv,
              allowReplyTool,
              { hasTool: true }
            );
            hasReplied = true;
            if (ctx.desireManager) {
              try {
                await ctx.desireManager.onBotMessage(finalMsgTool, {
                  proactive: !!msg?._proactive
                });
              } catch (e) {
                logger.debug('DesireManager onBotMessage(ToolResult) failed', {
                  err: String(e)
                });
              }
            }
            markReplySentForConversation(conversationId);
          }
        } else {
          logger.info(`ToolResult 阶段: 模型选择保持沉默 (noReply=true)，跳过发送`);
        }
      }

      if (ev.type === 'summary') {
        logger.info('对话总结', ev.summary);

        if (ev.runId) {
          untrackRunForSender(userid, groupId, ev.runId);
        }

        if (isCancelled) {
          logger.info(`任务已取消: ${groupId} 跳过保存对话对Summary阶段`);
          if (pairId) {
            logger.debug(`清理pairId: ${groupId} pairId ${pairId?.substring(0, 8)}`);
            await historyManager.cancelConversationPairById(groupId, pairId);
            pairId = null;
          }
          break;
        }

        if (pairId) {
          logger.debug(`保存对话对: ${groupId} pairId ${pairId.substring(0, 8)}`);
          const saved = await historyManager.finishConversationPair(
            groupId,
            pairId,
            currentUserContent
          );
          if (!saved) {
            logger.warn(`保存失败: ${groupId} pairId ${pairId.substring(0, 8)} 状态不一致`);
          }

          if (saved) {
            const chatType = msg?.group_id ? 'group' : 'private';
            const userIdForMemory = userid || '';
            triggerContextSummarizationIfNeeded({ groupId, chatType, userId: userIdForMemory }).catch(
              (e) => {
                logger.debug(`ContextMemory: 异步摘要触发失败 ${groupId}`, { err: String(e) });
              }
            );
          }

          pairId = null;
        } else {
          logger.warn(`跳过保存: ${groupId} pairId为null`);
        }
        break;
      }
    }
  } catch (error) {
    logger.error('处理消息异常: ', error);

    if (pairId) {
      logger.debug(`取消pairId-异常: ${groupId} pairId ${pairId.substring(0, 8)}`);
      await historyManager.cancelConversationPairById(groupId, pairId);
    }
  } finally {
    if (currentTaskId) {
      clearCancelledTask(currentTaskId);
    }
    // 任务完成，释放并发槽位并尝试拉起队列中的下一条
    // completeTask 会自动调用 replyPolicy.js 中的 removeActiveTask
    if (taskId && userid) {
      const next = await completeTask(userid, taskId);
      if (next && next.msg) {
        const nextUserId = String(next.msg?.sender_id ?? '');
        // 队列中的任务作为新的聚合会话起点
        startBundleForQueuedMessage(nextUserId, next.msg);
        const bundledNext = await collectBundleForSender(nextUserId);
        if (bundledNext) {
          await handleOneMessageCore(ctx, bundledNext, next.id);
        }
      }

      // 检查是否有待处理的消息（延迟聚合）
      const mergedMsg = drainPendingMessagesForSender(userid);
      if (mergedMsg) {
        const replyDecision = await shouldReply(mergedMsg, { source: 'pending_merged' });
        if (replyDecision.needReply) {
          logger.info(
            `延迟聚合回复决策: ${replyDecision.reason} (taskId=${replyDecision.taskId})`
          );
          await handleOneMessageCore(ctx, mergedMsg, replyDecision.taskId);
        } else {
          logger.debug(`延迟聚合跳过: ${replyDecision.reason}`);
        }
      }
    }

    logger.debug(`任务清理完成: ${groupId} sender ${userid}`);
  }
}
