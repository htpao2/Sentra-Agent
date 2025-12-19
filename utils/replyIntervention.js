import { Agent } from '../agent.js';
import { createLogger } from './logger.js';
import { getEnv, getEnvInt, getEnvBool } from './envHotReloader.js';
import { initAgentPresetCore } from '../components/AgentPresetInitializer.js';
import { loadPrompt } from '../prompts/loader.js';
import { chatWithRetry as chatWithRetryCore } from '../components/ChatWithRetry.js';
import { parseSentraResponse } from './protocolUtils.js';

const logger = createLogger('ReplyIntervention');

let cachedPresetContextForDecision = null;
let presetInitPromiseForDecision = null;

const REPLY_DECISION_PROMPT_NAME = 'reply_decision';
const REPLY_DEDUP_PROMPT_NAME = 'reply_dedup';
const REPLY_OVERRIDE_PROMPT_NAME = 'reply_override';

let cachedReplyDecisionSystemPrompt = null;
let cachedReplyDedupSystemPrompt = null;
let cachedReplyOverrideSystemPrompt = null;

async function getDecisionAgentPresetContext() {
  if (cachedPresetContextForDecision !== null) {
    return cachedPresetContextForDecision;
  }

  if (!presetInitPromiseForDecision) {
    presetInitPromiseForDecision = (async () => {
      try {
        const presetAgent = getAgent && typeof getAgent === 'function' ? getAgent() : null;
        const snapshot = await initAgentPresetCore(presetAgent || null);
        const xml = snapshot && typeof snapshot.xml === 'string' ? snapshot.xml.trim() : '';
        const plain = snapshot && typeof snapshot.plainText === 'string' ? snapshot.plainText.trim() : '';

        let context = '';
        if (xml) {
          context = xml;
        } else if (plain) {
          const maxLen = 4000;
          const truncated = plain.length > maxLen ? plain.slice(0, maxLen) : plain;
          context = [
            '<sentra-agent-preset-text>',
            escapeXmlText(truncated),
            '</sentra-agent-preset-text>'
          ].join('\n');
        }

        cachedPresetContextForDecision = context || '';

        if (cachedPresetContextForDecision) {
          logger.info('ReplyIntervention: 已加载 Agent 预设上下文用于回复决策');
        }

        return cachedPresetContextForDecision;
      } catch (e) {
        logger.warn('ReplyIntervention: 加载 Agent 预设失败，将不注入人设上下文', { err: String(e) });
        cachedPresetContextForDecision = '';
        return cachedPresetContextForDecision;
      }
    })();
  }

  return presetInitPromiseForDecision;
}

function isReplyInterventionEnabled() {
  return getEnvBool('ENABLE_REPLY_INTERVENTION', true);
}

function getDecisionConfig() {
  const mainModel = getEnv('MAIN_AI_MODEL', 'gpt-3.5-turbo');
  const model = getEnv('REPLY_DECISION_MODEL', mainModel || 'gpt-4o-mini');
  const maxTokens = getEnvInt('REPLY_DECISION_MAX_TOKENS', 128);
  const maxRetries = getEnvInt('REPLY_DECISION_MAX_RETRIES', getEnvInt('MAX_RETRIES', 3));
  const timeout = getEnvInt('REPLY_DECISION_TIMEOUT', getEnvInt('TIMEOUT', 15000));
  return { model, maxTokens, maxRetries, timeout };
}

let sharedAgent = null;

function getAgent() {
  if (!isReplyInterventionEnabled()) {
    return null;
  }
  if (sharedAgent) {
    return sharedAgent;
  }
  try {
    const { model, maxTokens, maxRetries, timeout } = getDecisionConfig();
    sharedAgent = new Agent({
      // 复用主站点配置，避免单独维护一套 API_KEY/API_BASE_URL
      apiKey: getEnv('API_KEY'),
      apiBaseUrl: getEnv('API_BASE_URL', 'https://yuanplus.chat/v1'),
      defaultModel: model,
      temperature: 0,
      maxTokens,
      maxRetries,
      timeout
    });
    logger.config('ReplyIntervention 初始化', {
      model,
      maxTokens
    });
  } catch (e) {
    logger.error('初始化 ReplyIntervention Agent 失败，将回退为默认必回策略', e);
    sharedAgent = null;
  }
  return sharedAgent;
}

async function getReplyDecisionSystemPrompt() {
  try {
    if (cachedReplyDecisionSystemPrompt) {
      return cachedReplyDecisionSystemPrompt;
    }
    const data = await loadPrompt(REPLY_DECISION_PROMPT_NAME);
    const system = data && typeof data.system === 'string' ? data.system : '';
    if (system) {
      cachedReplyDecisionSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('ReplyIntervention: 加载 reply_decision prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return '<role>reply_decision_classifier</role>';
}

async function getReplyDedupSystemPrompt() {
  try {
    if (cachedReplyDedupSystemPrompt) {
      return cachedReplyDedupSystemPrompt;
    }
    const data = await loadPrompt(REPLY_DEDUP_PROMPT_NAME);
    const system = data && typeof data.system === 'string' ? data.system : '';
    if (system) {
      cachedReplyDedupSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('ReplyIntervention: 加载 reply_dedup prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return '<role>send_dedup_judge</role>';
}

async function getReplyOverrideSystemPrompt() {
  try {
    if (cachedReplyOverrideSystemPrompt) {
      return cachedReplyOverrideSystemPrompt;
    }
    const data = await loadPrompt(REPLY_OVERRIDE_PROMPT_NAME);
    const system = data && typeof data.system === 'string' ? data.system : '';
    if (system) {
      cachedReplyOverrideSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('ReplyIntervention: 加载 reply_override prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return '<role>override_intent_classifier</role>';
}

function escapeXmlText(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function buildUserPayload(msg, extraSignals = {}, context = null, policyConfig = null) {
  const scene = msg?.type || 'unknown';
  const text = typeof msg?.text === 'string' ? msg.text : '';
  const summary = typeof msg?.summary === 'string' ? msg.summary : '';

  const payload = {
    scene,
    sender_id: String(msg?.sender_id ?? ''),
    sender_name: msg?.sender_name || '',
    group_id: msg?.group_id ?? null,
    text,
    summary,
    signals: {
      is_group: scene === 'group',
      is_private: scene === 'private',
      ...extraSignals
    }
  };

  if (context && typeof context === 'object') {
    payload.context = context;
  }

  const fullText = text || '';
  const fullSummary = summary || '';
  const messageFeatures = {
    text_length: fullText.length,
    summary_length: fullSummary.length,
    has_question_mark: /[?？]/.test(fullText),
    has_url: /(https?:\/\/|www\.)/i.test(fullText),
    has_at_symbol: /@/.test(fullText)
  };
  payload.message_features = messageFeatures;

  if (policyConfig && typeof policyConfig === 'object') {
    payload.policy_config = policyConfig;
  }

  const json = JSON.stringify(payload);

  const lines = [];
  lines.push('<decision_input>');
  lines.push(`<scene>${scene}</scene>`);
  lines.push('<sender>');
  lines.push(`<id>${payload.sender_id}</id>`);
  lines.push(`<name>${payload.sender_name}</name>`);
  lines.push('</sender>');
  lines.push(`<group_id>${payload.group_id ?? ''}</group_id>`);
  lines.push('<message>');
  lines.push(`<text>${text}</text>`);
  lines.push(`<summary>${summary}</summary>`);
  lines.push('</message>');
  const boolStr = (v) => (v ? 'true' : 'false');

  const mf = payload.message_features || messageFeatures;
  lines.push('<message_features>');
  lines.push(`<text_length>${
    typeof mf.text_length === 'number' ? String(mf.text_length) : ''
  }</text_length>`);
  lines.push(`<summary_length>${
    typeof mf.summary_length === 'number' ? String(mf.summary_length) : ''
  }</summary_length>`);
  lines.push(`<has_question_mark>${boolStr(!!mf.has_question_mark)}</has_question_mark>`);
  lines.push(`<has_url>${boolStr(!!mf.has_url)}</has_url>`);
  lines.push(`<has_at_symbol>${boolStr(!!mf.has_at_symbol)}</has_at_symbol>`);
  lines.push('</message_features>');

  const sig = payload.signals || {};

  lines.push('<signals>');
  lines.push(`<is_group>${boolStr(sig.is_group)}</is_group>`);
  lines.push(`<is_private>${boolStr(sig.is_private)}</is_private>`);
  lines.push(`<mentioned_by_at>${boolStr(!!sig.mentioned_by_at)}</mentioned_by_at>`);
  lines.push(`<mentioned_by_name>${boolStr(!!sig.mentioned_by_name)}</mentioned_by_name>`);
  const names = Array.isArray(sig.mentioned_names) ? sig.mentioned_names.join(',') : '';
  lines.push(`<mentioned_names>${names}</mentioned_names>`);
  lines.push(`<senderReplyCountWindow>${
    typeof sig.senderReplyCountWindow === 'number' ? String(sig.senderReplyCountWindow) : ''
  }</senderReplyCountWindow>`);
  lines.push(`<groupReplyCountWindow>${
    typeof sig.groupReplyCountWindow === 'number' ? String(sig.groupReplyCountWindow) : ''
  }</groupReplyCountWindow>`);
  lines.push(`<senderFatigue>${
    typeof sig.senderFatigue === 'number' ? String(sig.senderFatigue) : ''
  }</senderFatigue>`);
  lines.push(`<groupFatigue>${
    typeof sig.groupFatigue === 'number' ? String(sig.groupFatigue) : ''
  }</groupFatigue>`);
  lines.push(`<senderLastReplyAgeSec>${
    typeof sig.senderLastReplyAgeSec === 'number' ? String(sig.senderLastReplyAgeSec) : ''
  }</senderLastReplyAgeSec>`);
  lines.push(`<groupLastReplyAgeSec>${
    typeof sig.groupLastReplyAgeSec === 'number' ? String(sig.groupLastReplyAgeSec) : ''
  }</groupLastReplyAgeSec>`);
  lines.push(`<is_followup_after_bot_reply>${boolStr(!!sig.is_followup_after_bot_reply)}</is_followup_after_bot_reply>`);
  lines.push(`<activeTaskCount>${
    typeof sig.activeTaskCount === 'number' ? String(sig.activeTaskCount) : ''
  }</activeTaskCount>`);
  lines.push('</signals>');

  const pc = payload.policy_config || {};
  lines.push('<policy_config>');
  lines.push(`<mention_must_reply>${boolStr(!!pc.mentionMustReply)}</mention_must_reply>`);
  lines.push(`<followup_window_sec>${
    typeof pc.followupWindowSec === 'number' ? String(pc.followupWindowSec) : ''
  }</followup_window_sec>`);
  const pa = pc.attention || {};
  lines.push('<attention>');
  lines.push(`<enabled>${boolStr(!!pa.enabled)}</enabled>`);
  lines.push(`<window_ms>${
    typeof pa.windowMs === 'number' ? String(pa.windowMs) : ''
  }</window_ms>`);
  lines.push(`<max_senders>${
    typeof pa.maxSenders === 'number' ? String(pa.maxSenders) : ''
  }</max_senders>`);
  lines.push('</attention>');
  const uf = pc.userFatigue || {};
  lines.push('<user_fatigue>');
  lines.push(`<enabled>${boolStr(!!uf.enabled)}</enabled>`);
  lines.push(`<window_ms>${
    typeof uf.windowMs === 'number' ? String(uf.windowMs) : ''
  }</window_ms>`);
  lines.push(`<base_limit>${
    typeof uf.baseLimit === 'number' ? String(uf.baseLimit) : ''
  }</base_limit>`);
  lines.push(`<min_interval_ms>${
    typeof uf.minIntervalMs === 'number' ? String(uf.minIntervalMs) : ''
  }</min_interval_ms>`);
  lines.push(`<backoff_factor>${
    typeof uf.backoffFactor === 'number' ? String(uf.backoffFactor) : ''
  }</backoff_factor>`);
  lines.push(`<max_backoff_multiplier>${
    typeof uf.maxBackoffMultiplier === 'number' ? String(uf.maxBackoffMultiplier) : ''
  }</max_backoff_multiplier>`);
  lines.push('</user_fatigue>');
  const gf = pc.groupFatigue || {};
  lines.push('<group_fatigue>');
  lines.push(`<enabled>${boolStr(!!gf.enabled)}</enabled>`);
  lines.push(`<window_ms>${
    typeof gf.windowMs === 'number' ? String(gf.windowMs) : ''
  }</window_ms>`);
  lines.push(`<base_limit>${
    typeof gf.baseLimit === 'number' ? String(gf.baseLimit) : ''
  }</base_limit>`);
  lines.push(`<min_interval_ms>${
    typeof gf.minIntervalMs === 'number' ? String(gf.minIntervalMs) : ''
  }</min_interval_ms>`);
  lines.push(`<backoff_factor>${
    typeof gf.backoffFactor === 'number' ? String(gf.backoffFactor) : ''
  }</backoff_factor>`);
  lines.push(`<max_backoff_multiplier>${
    typeof gf.maxBackoffMultiplier === 'number' ? String(gf.maxBackoffMultiplier) : ''
  }</max_backoff_multiplier>`);
  lines.push('</group_fatigue>');
  lines.push('</policy_config>');

  lines.push('<context>');
  const ctx = payload.context || {};
  const groupMsgs = Array.isArray(ctx.group_recent_messages) ? ctx.group_recent_messages : [];
  const senderMsgs = Array.isArray(ctx.sender_recent_messages) ? ctx.sender_recent_messages : [];

  lines.push('<group_recent_messages>');
  for (const m of groupMsgs) {
    const mid = m?.sender_id != null ? String(m.sender_id) : '';
    const mname = m?.sender_name || '';
    const mtext = m?.text || '';
    const mtime = m?.time || '';
    lines.push('<message>');
    lines.push(`<sender_id>${mid}</sender_id>`);
    lines.push(`<sender_name>${mname}</sender_name>`);
    lines.push(`<text>${mtext}</text>`);
    lines.push(`<time>${mtime}</time>`);
    lines.push('</message>');
  }
  lines.push('</group_recent_messages>');

  lines.push('<sender_recent_messages>');
  for (const m of senderMsgs) {
    const mid = m?.sender_id != null ? String(m.sender_id) : '';
    const mname = m?.sender_name || '';
    const mtext = m?.text || '';
    const mtime = m?.time || '';
    lines.push('<message>');
    lines.push(`<sender_id>${mid}</sender_id>`);
    lines.push(`<sender_name>${mname}</sender_name>`);
    lines.push(`<text>${mtext}</text>`);
    lines.push(`<time>${mtime}</time>`);
    lines.push('</message>');
  }
  lines.push('</sender_recent_messages>');
  lines.push('</context>');

  lines.push('<payload_json>');
  lines.push(json);
  lines.push('</payload_json>');
  lines.push('</decision_input>');

  return lines.join('\n');
}

/**
 * 群聊回复决策入口
 *
 * @param {Object} msg - 原始消息对象
 * @param {Object} options - 附加信号（由上层解析）
 * @param {Object} options.signals - 结构化信号，例如 { mentionedByAt, mentionedByName, mentionedNames }
 * @returns {Promise<{ shouldReply: boolean, confidence: number, reason: string, priority: string, shouldQuote: boolean, raw?: any }|null>}
 */
export async function planGroupReplyDecision(msg, options = {}) {
  if (!isReplyInterventionEnabled()) {
    return null;
  }

  const agent = getAgent();
  if (!agent) {
    return null;
  }

  const signals = options.signals || {};
  const extraSignals = {
    mentioned_by_at: !!signals.mentionedByAt,
    mentioned_by_name: !!signals.mentionedByName,
    mentioned_names: Array.isArray(signals.mentionedNames) ? signals.mentionedNames : [],
    senderReplyCountWindow: typeof signals.senderReplyCountWindow === 'number' ? signals.senderReplyCountWindow : 0,
    groupReplyCountWindow: typeof signals.groupReplyCountWindow === 'number' ? signals.groupReplyCountWindow : 0,
    senderFatigue: typeof signals.senderFatigue === 'number' ? signals.senderFatigue : 0,
    groupFatigue: typeof signals.groupFatigue === 'number' ? signals.groupFatigue : 0,
    senderLastReplyAgeSec: typeof signals.senderLastReplyAgeSec === 'number' ? signals.senderLastReplyAgeSec : null,
    groupLastReplyAgeSec: typeof signals.groupLastReplyAgeSec === 'number' ? signals.groupLastReplyAgeSec : null,
    is_followup_after_bot_reply: !!signals.isFollowupAfterBotReply,
    activeTaskCount: typeof signals.activeTaskCount === 'number' ? signals.activeTaskCount : 0
  };

  const scene = msg?.type || 'unknown';
  const safeGroupId = msg?.group_id != null ? String(msg.group_id) : '';
  const safeSenderId = msg?.sender_id != null ? String(msg.sender_id) : '';

  const decisionInputXml = buildUserPayload(
    msg,
    extraSignals,
    options.context || null,
    options.policy || null
  );

  const rdLines = [];
  rdLines.push('<sentra-root-directive>');
  rdLines.push('  <id>reply_gate_v1</id>');
  rdLines.push('  <type>reply_gate</type>');
  rdLines.push('  <scope>conversation</scope>');
  rdLines.push('  <target>');
  rdLines.push(`    <chat_type>${scene}</chat_type>`);
  if (safeGroupId) {
    rdLines.push(`    <group_id>${safeGroupId}</group_id>`);
  }
  if (safeSenderId) {
    rdLines.push(`    <user_id>${safeSenderId}</user_id>`);
  }
  rdLines.push('  </target>');

  rdLines.push('  <objective>');
  rdLines.push(
    '    本轮你的任务不是直接生成给用户看的聊天回复，而是在 Sentra 沙盒环境中，根据当前这条消息及其上下文，判断“本轮你是否应该开口参与对话，以及以什么强度参与”。'
  );
  rdLines.push(
    '    你需要综合考虑：这条消息主要是在跟谁说话（是否显式 @ 你、是否用你的昵称/别称直接称呼你）、对话现在在讨论什么、你上一轮是否刚刚发言，以及群聊礼仪和不打扰原则。'
  );
  rdLines.push(
    '    你的最终决策通过 <sentra-response> 是否为空来表达：'
  );
  rdLines.push(
    '    - 当你认定“本轮需要你参与”（例如：需要你回答问题、澄清信息、针对你上一轮的回答做跟进，或以轻量方式加入气氛）时，应输出一个非空的 <sentra-response>，其中的 <textN> 文本只用于向平台解释你做出该判断的核心理由，不会直接展示给用户。'
  );
  rdLines.push(
    '    - 当你认定“本轮保持沉默或仅作为旁观者更合适”时，请输出一个完全空的 <sentra-response> 块（不包含任何 <textN>、<resources>、<emoji>），表示本轮不进入主对话/MCP 流程，由系统静默记录为内部观察。'
  );
  rdLines.push(
    '    在本 root 指令下，你不负责生成正式的用户可见回复内容，也不负责调用工具；你只是做一次“是否需要由你发声、以及是否值得进入完整主对话流程”的价值判断。'
  );
  rdLines.push('  </objective>');

  rdLines.push('  <allow_tools>false</allow_tools>');

  rdLines.push('  <constraints>');
  rdLines.push('    <item>优先遵循平台关于群聊礼仪和不打扰原则：如果没有明确需要你发言的信号，应默认保持安静，而不是对每条群消息都给出评价。</item>');
  rdLines.push('    <item>显式 @ 你（mentioned_by_at=true），或者在文本中用你的昵称/别称以“直接对你说话”的方式提出请求或问题（例如“失语你帮我看看这个报错”“Aphasia 帮我写个脚本”），通常可视为明确点名，如果内容确实需要你的能力支持，应倾向于判定为“值得继续对话”。</item>');
  rdLines.push('    <item>当用户只是以第三人称提到你（例如“刚才失语好可爱”“失语前面那条说得不错”“@其他人：你看失语刚刚说的那个”），一般不要立即认为这是在和你对话；除非上下文明确表明他们正在等待你的进一步回应，否则应更倾向于保持沉默，只在极少数场景下建议用轻量表情/资源参与气氛，而不是长篇发言。</item>');
  rdLines.push('    <item>当 is_followup_after_bot_reply=true 且本条消息在语义上明显是基于你上一轮回答进行的追问、补充条件或指正错误时，应更倾向于认为需要继续对话；但如果只是简单致谢或短促寒暄（如“谢谢”“收到啦”“好耶”），尤其在你近期回复频繁时，可以选择保持沉默，以免刷屏。</item>');
  rdLines.push('    <item>请结合 senderReplyCountWindow / groupReplyCountWindow、senderFatigue / groupFatigue 等信号理解近期负载：在高频场景下，你只有在信号特别明确（显式点名、清晰问题、明显纠错）时才应继续发言；否则应优先选择沉默，或在极少数合适场景下仅以表情/轻量资源旁观。</item>');
  rdLines.push('    <item>如果当前消息主要是群成员之间的闲聊、内部梗、彼此互动，而你介入只会打断气氛或让对话变得机械，请判定为“本轮保持沉默”；只有当你能明显带来信息价值或积极情绪反馈时，才判断为需要参与。</item>');
  rdLines.push('    <item>你在本轮不负责真正写出发给用户看的正式聊天内容，也不负责规划工具调用；你只需在 <sentra-response> 中用一到数条简短的 <textN>，以自然语言向平台解释“为什么需要/不需要让你说话”，这些说明仅供内部使用，不会直接展示给用户。</item>');
  rdLines.push('  </constraints>');

  rdLines.push('  <meta>');
  rdLines.push('    <note>下面的 <decision_input> 是一个结构化的辅助输入，其中已经包含了本条消息、群/用户的疲劳度、是否被 @ 以及最近对话的摘要等信号，你可以将其视为只读背景数据，用于支撑你的价值判断。</note>');
  rdLines.push('  </meta>');

  const indentedDecision = decisionInputXml
    .split('\n')
    .map((line) => (line ? `  ${line}` : ''))
    .join('\n');
  rdLines.push(indentedDecision);
  rdLines.push('</sentra-root-directive>');

  const userContent = rdLines.join('\n');

  try {
    const { model, maxTokens } = getDecisionConfig();
    const presetContext = await getDecisionAgentPresetContext();
    const systemPrompt = await getReplyDecisionSystemPrompt();

    const systemContent = [systemPrompt, presetContext].filter(Boolean).join('\n\n');
    const conversations = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];

    const groupIdForLog = msg?.group_id != null ? `reply_gate_${msg.group_id}` : 'reply_gate';
    const result = await chatWithRetryCore(
      agent,
      conversations,
      { model, maxTokens },
      groupIdForLog
    );

    if (!result || !result.success || !result.response) {
      const reason = `chatWithRetry failed: ${result?.reason || 'unknown'}`;
      logger.warn('ReplyIntervention: chatWithRetry 返回失败结果，将默认判定为无需回复', {
        reason
      });
      return {
        shouldReply: false,
        confidence: 0.0,
        reason,
        priority: 'normal',
        shouldQuote: false,
        raw: result || null
      };
    }

    const rawText =
      typeof result.response === 'string'
        ? result.response
        : String(result.response ?? '');

    let parsed;
    try {
      parsed = parseSentraResponse(rawText);
    } catch (e) {
      logger.warn('ReplyIntervention: 解析 <sentra-response> 失败，将默认判定为无需回复', {
        err: String(e),
        snippet: rawText.slice(0, 500)
      });
      return {
        shouldReply: false,
        confidence: 0.0,
        reason: 'parseSentraResponse failed',
        priority: 'normal',
        shouldQuote: false,
        raw: { error: String(e), snippet: rawText.slice(0, 200) }
      };
    }

    const shouldSkip = !!parsed.shouldSkip;
    const shouldReply = !shouldSkip;

    let preview = '';
    if (Array.isArray(parsed.textSegments) && parsed.textSegments.length > 0) {
      preview = parsed.textSegments
        .map((s) => (s || '').trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 120);
    }

    const reasonText = preview
      ? `ReplyGate(sentra-response): ${preview}`
      : shouldReply
        ? 'ReplyGate(sentra-response): 模型判定值得进入主对话流程'
        : 'ReplyGate(sentra-response): 模型判定本轮保持沉默';

    const confidence = shouldReply ? 1.0 : 1.0;
    const priority = 'normal';
    const shouldQuote = false;

    logger.info(
      `ReplyIntervention 判定: shouldReply=${shouldReply}, shouldSkip=${shouldSkip}, replyMode=${parsed.replyMode || 'none'}, reason=${reasonText}`
    );

    return {
      shouldReply,
      confidence,
      reason: reasonText,
      priority,
      shouldQuote,
      raw: rawText
    };
  } catch (e) {
    logger.warn('ReplyIntervention: 调用 LLM 决策失败，将默认判定为无需回复', { err: String(e) });
    return {
      shouldReply: false,
      confidence: 0.0,
      reason: 'LLM decision failed (timeout or API error), default no reply',
      priority: 'normal',
      shouldQuote: false,
      raw: { error: String(e) }
    };
  }
}

export async function decideSendDedupPair(baseText, candidateText) {
  if (!isReplyInterventionEnabled()) {
    return null;
  }

  const agent = getAgent();
  if (!agent) {
    return null;
  }

  const a = (baseText || '').trim();
  const b = (candidateText || '').trim();
  if (!a || !b) {
    return null;
  }

  try {
    const { model, maxTokens } = getDecisionConfig();
    const systemPrompt = await getReplyDedupSystemPrompt();

    const rdLines = [];
    rdLines.push('<sentra-root-directive>');
    rdLines.push('  <id>send_dedup_v1</id>');
    rdLines.push('  <type>send_dedup</type>');
    rdLines.push('  <scope>assistant_reply</scope>');
    rdLines.push('  <objective>');
    rdLines.push(
      '    给定同一轮对话中的两条候选机器人回复 A(基准) 和 B(候选)，请站在用户视角判断：如果已经发送了 A，是否还有必要再发送 B。'
    );
    rdLines.push(
      '    如果 B 在事实、约束、语气和主要意图上已经充分覆盖了 A（即用户收到 B 后不会再需要看到 A），则视为语义重复，可以只保留 B。'
    );
    rdLines.push(
      '    如果 A 和 B 含有不同的重要信息、不同的建议、或相互补充的内容，则视为非重复，两者均有价值。'
    );
    rdLines.push(
      '    你的任务只是做“是否重复/是否可以只发送 B”这一价值判断，不会直接把任何回复发给用户。'
    );
    rdLines.push('  </objective>');

    rdLines.push('  <constraints>');
    rdLines.push('    <item>忽略轻微的措辞差异、语气词、表情符号或简短寒暄，这些通常不构成新的信息。</item>');
    rdLines.push('    <item>如果 B 只是对 A 做了更精炼或更顺滑的表达，但核心事实和建议完全一样，也可视为重复。</item>');
    rdLines.push('    <item>如果 B 引入了新的事实、步骤、警告或与 A 相矛盾的结论，则应视为非重复。</item>');
    rdLines.push('    <item>你可以在不确定时输出空的 &lt;sentra-response&gt;（不含任何 &lt;textN&gt; 和资源），表示“无决策，交给本地规则处理”。</item>');
    rdLines.push('  </constraints>');

    rdLines.push('  <meta>');
    rdLines.push('    <note>下面的 &lt;send_dedup_input&gt; 给出了候选回复 A/B 文本，仅用于内部判断，不会直接展示给用户。</note>');
    rdLines.push('  </meta>');

    rdLines.push('  <send_dedup_input>');
    rdLines.push('    <base_text>');
    rdLines.push(escapeXmlText(a));
    rdLines.push('    </base_text>');
    rdLines.push('    <candidate_text>');
    rdLines.push(escapeXmlText(b));
    rdLines.push('    </candidate_text>');
    rdLines.push('  </send_dedup_input>');
    rdLines.push('</sentra-root-directive>');

    const userContent = rdLines.join('\n');

    const conversations = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const result = await chatWithRetryCore(
      agent,
      conversations,
      { model, maxTokens },
      'send_dedup'
    );

    if (!result || !result.success || !result.response) {
      const reason = `chatWithRetry failed: ${result?.reason || 'unknown'}`;
      logger.warn('SendDedup: chatWithRetry 返回失败结果，将回退为仅基于向量相似度判断', {
        reason
      });
      return null;
    }

    const rawText =
      typeof result.response === 'string'
        ? result.response
        : String(result.response ?? '');

    let parsed;
    try {
      parsed = parseSentraResponse(rawText);
    } catch (e) {
      logger.warn('SendDedup: 解析 <sentra-response> 失败，将回退为仅基于向量相似度判断', {
        err: String(e),
        snippet: rawText.slice(0, 500)
      });
      return null;
    }

    if (parsed.shouldSkip) {
      logger.info('SendDedup: 模型选择输出空 sentra-response，视为无决策，回退为仅基于向量相似度判断');
      return null;
    }

    const segments = Array.isArray(parsed.textSegments) ? parsed.textSegments : [];
    let areSimilar = null;
    let similarity = null;
    let reason = '';

    for (const seg of segments) {
      const s = (seg || '').trim();
      if (!s) continue;

      if (areSimilar === null) {
        const m = s.match(/\bARE_SIMILAR\s*=\s*(true|false)\b/i);
        if (m) {
          areSimilar = m[1].toLowerCase() === 'true';
          continue;
        }
      }

      if (similarity == null) {
        const m2 = s.match(/\bSIMILARITY\s*=\s*([0-9]+(?:\.[0-9]+)?)\b/i);
        if (m2) {
          const n = parseFloat(m2[1]);
          if (!Number.isNaN(n)) {
            similarity = Math.min(1, Math.max(0, n));
          }
          continue;
        }
      }

      if (!reason) {
        reason = s;
      }
    }

    if (areSimilar === null) {
      logger.warn('SendDedup: sentra-response 中未找到 ARE_SIMILAR= 标记，将回退为仅基于向量相似度判断', {
        snippet: rawText.slice(0, 200)
      });
      return null;
    }

    if (!reason) {
      reason = areSimilar ? '模型判定为重复回复' : '模型判定为非重复回复';
    }

    if (similarity != null && !Number.isNaN(similarity)) {
      similarity = Math.min(1, Math.max(0, similarity));
    } else {
      similarity = null;
    }

    logger.info(
      `SendDedup 判定: areSimilar=${areSimilar}, similarity=${
        similarity != null ? similarity.toFixed(3) : 'null'
      }, reason=${reason}`
    );

    return { areSimilar, similarity, reason, raw: rawText };
  } catch (e) {
    logger.warn('SendDedup: 调用 LLM 决策失败，将回退为仅基于向量相似度判断', { err: String(e) });
    return null;
  }
}
export async function decideOverrideIntent(payload) {
  if (!isReplyInterventionEnabled()) {
    return null;
  }

  const agent = getAgent();
  if (!agent) {
    return null;
  }

  try {
    const safePayload = {
      scene: payload?.scene || 'unknown',
      senderId: payload?.senderId || '',
      groupId: payload?.groupId || '',
      prevMessages: Array.isArray(payload?.prevMessages) ? payload.prevMessages.slice(-5) : [],
      newMessage: payload?.newMessage || null
    };

    const lines = [];
    lines.push('<override_decision_input>');
    lines.push(`<scene>${escapeXmlText(safePayload.scene)}</scene>`);
    lines.push(`<sender_id>${escapeXmlText(safePayload.senderId)}</sender_id>`);
    lines.push(`<group_id>${escapeXmlText(safePayload.groupId || '')}</group_id>`);
    lines.push('<prev_messages>');
    for (const m of safePayload.prevMessages) {
      if (!m || (!m.text && !m.summary)) continue;
      const text = m.text || m.summary || '';
      const time = m.time || '';
      lines.push('<message>');
      lines.push(`<text>${escapeXmlText(text)}</text>`);
      lines.push(`<time>${escapeXmlText(time)}</time>`);
      lines.push('</message>');
    }
    lines.push('</prev_messages>');

    const nm = safePayload.newMessage || {};
    const nmText = nm.text || nm.summary || '';
    const nmTime = nm.time || '';
    lines.push('<new_message>');
    lines.push(`<text>${escapeXmlText(nmText)}</text>`);
    lines.push(`<time>${escapeXmlText(nmTime)}</time>`);
    lines.push('</new_message>');
    lines.push('</override_decision_input>');

    const { model, maxTokens } = getDecisionConfig();
    const systemPrompt = await getReplyOverrideSystemPrompt();

    const rdLines = [];
    rdLines.push('<sentra-root-directive>');
    rdLines.push('  <id>override_intent_v1</id>');
    rdLines.push('  <type>override_intent</type>');
    rdLines.push('  <scope>conversation</scope>');
    rdLines.push('  <target>');
    rdLines.push(`    <chat_type>${escapeXmlText(safePayload.scene)}</chat_type>`);
    if (safePayload.groupId) {
      rdLines.push(`    <group_id>${escapeXmlText(safePayload.groupId)}</group_id>`);
    }
    if (safePayload.senderId) {
      rdLines.push(`    <user_id>${escapeXmlText(safePayload.senderId)}</user_id>`);
    }
    rdLines.push('  </target>');

    rdLines.push('  <objective>');
    rdLines.push(
      '    当系统已经在为该用户执行一个“旧任务”时，你需要判断最新一条消息是否可以视为“改主意 / 换了一个新的主要需求”。'
    );
    rdLines.push(
      '    你的输出不会直接展示给用户，而是作为内部信号：通过是否在 <sentra-response> 中给出非空文本，来暗示是否需要取消旧任务、优先处理这条新消息。'
    );
    rdLines.push('  </objective>');

    rdLines.push('  <constraints>');
    rdLines.push(
      '    <item>如果新消息明确改变或替换了主要需求（例如“算了，帮我改成 XXX”、“不要之前那个了，改成……”），或与旧任务目标明显冲突/取代旧目标，可以认为需要取消旧任务、改为执行最新指令。</item>'
    );
    rdLines.push(
      '    <item>如果新消息只是补充参数、细节或修正错误（例如补充截图、纠正一个字段名、对你的回答作一点反馈），通常不需要取消旧任务。</item>'
    );
    rdLines.push(
      '    <item>如果新消息完全是另一个话题的闲聊或社交内容，且不会影响旧任务的正确性与必要性，可以保持旧任务继续执行。</item>'
    );
    rdLines.push(
      '    <item>当你判断“需要取消旧任务”时，请在 <sentra-response> 中输出一到数条简短的 &lt;textN&gt; 文本，总结核心理由；当你判断“不需要取消”时，请输出一个完全空的 &lt;sentra-response&gt;（不含任何 &lt;textN&gt;、资源或 &lt;emoji&gt; 标签）。</item>'
    );
    rdLines.push('  </constraints>');

    rdLines.push('  <meta>');
    rdLines.push('    <note>下面的 &lt;override_decision_input&gt; 提供了按时间排序的历史消息摘要和最新一条消息文本，仅用于内部改意愿判断。</note>');
    rdLines.push('  </meta>');

    const indentedInput = lines
      .join('\n')
      .split('\n')
      .map((line) => (line ? `  ${line}` : ''))
      .join('\n');
    rdLines.push(indentedInput);
    rdLines.push('</sentra-root-directive>');

    const userContent = rdLines.join('\n');

    const conversations = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const groupIdForLog = safePayload.groupId
      ? `override_${safePayload.groupId}`
      : safePayload.senderId
        ? `override_user_${safePayload.senderId}`
        : 'override';

    const result = await chatWithRetryCore(
      agent,
      conversations,
      { model, maxTokens },
      groupIdForLog
    );

    if (!result || !result.success || !result.response) {
      const reason = `chatWithRetry failed: ${result?.reason || 'unknown'}`;
      logger.warn('OverrideIntervention: chatWithRetry 返回失败结果，将回退为不取消', {
        reason
      });
      return null;
    }

    const rawText =
      typeof result.response === 'string'
        ? result.response
        : String(result.response ?? '');

    let parsed;
    try {
      parsed = parseSentraResponse(rawText);
    } catch (e) {
      logger.warn('OverrideIntervention: 解析 <sentra-response> 失败，将回退为不取消', {
        err: String(e),
        snippet: rawText.slice(0, 500)
      });
      return null;
    }

    if (parsed.shouldSkip) {
      // 空 sentra-response：视为“本轮不建议取消当前任务”
      logger.info('OverrideIntervention: 模型输出空 sentra-response，视为不取消当前任务');
      return null;
    }

    const segments = Array.isArray(parsed.textSegments) ? parsed.textSegments : [];
    const joinedReason = segments
      .map((s) => (s || '').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 200);

    const relation = 'override';
    const shouldCancel = true;
    const confidence = 0.9;
    const reasonText = joinedReason || '模型判定最新消息代表用户改主意，需要取消当前任务并优先处理该消息';

    logger.info(
      `OverrideIntervention 判定: relation=${relation}, shouldCancel=${shouldCancel}, confidence=${(
        confidence * 100
      ).toFixed(1)}%, reason=${reasonText}`
    );

    return {
      relation,
      shouldCancel,
      confidence,
      reason: reasonText,
      raw: rawText
    };
  } catch (e) {
    logger.warn('OverrideIntervention: 调用 LLM 决策失败，将回退为不取消', { err: String(e) });
    return null;
  }
}

