import { createLogger } from '../utils/logger.js';
import { tokenCounter } from '../src/token-counter.js';
import { repairSentraResponse } from '../utils/formatRepair.js';
import { getEnv, getEnvInt, getEnvBool } from '../utils/envHotReloader.js';
import { extractAllFullXMLTags } from '../utils/xmlUtils.js';
import { parseReplyGateDecisionFromSentraTools, parseSendFusionFromSentraTools, parseSentraResponse } from '../utils/protocolUtils.js';

const logger = createLogger('ChatWithRetry');

function getMaxResponseRetries() {
  return getEnvInt('MAX_RESPONSE_RETRIES', 2);
}

function getMaxResponseTokens() {
  const raw = getEnvInt('MAX_RESPONSE_TOKENS', 260);
  return Number.isFinite(raw) ? raw : 260;
}

function getTokenCountModel() {
  return getEnv('TOKEN_COUNT_MODEL', 'gpt-4.1-mini');
}

function isStrictFormatCheckEnabled() {
  return getEnvBool('ENABLE_STRICT_FORMAT_CHECK', true);
}

function isFormatRepairEnabled() {
  return getEnvBool('ENABLE_FORMAT_REPAIR', true);
}

function extractFirstSentraResponseBlock(text) {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('<sentra-response>');
  if (start < 0) return null;
  const end = text.indexOf('</sentra-response>', start);
  if (end < 0) return null;
  return text.slice(start, end + '</sentra-response>'.length);
}

function extractOnlySentraToolsBlock(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const blocks = extractAllFullXMLTags(s, 'sentra-tools');
  if (blocks.length !== 1) return null;
  const merged = blocks[0].trim();
  if (merged !== s) return null;
  return merged;
}

function validateReplyGateDecisionToolsFormat(response) {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: '响应为空或非字符串' };
  }

  const normalized = extractOnlySentraToolsBlock(response);
  if (!normalized) {
    return { valid: false, reason: '缺少或不唯一的 <sentra-tools> 决策块' };
  }

  if (normalized.includes('<sentra-response>')) {
    return { valid: false, reason: '决策输出不允许包含 <sentra-response>' };
  }

  const decision = parseReplyGateDecisionFromSentraTools(normalized);
  if (!decision || typeof decision.enter !== 'boolean') {
    return { valid: false, reason: '缺少 reply_gate_decision 或 enter 参数' };
  }

  return { valid: true, normalized };
}

function validateSendFusionToolsFormat(response) {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: '响应为空或非字符串' };
  }

  const normalized = extractOnlySentraToolsBlock(response);
  if (!normalized) {
    return { valid: false, reason: '缺少或不唯一的 <sentra-tools> 融合输出块' };
  }

  if (normalized.includes('<sentra-response>')) {
    return { valid: false, reason: '融合输出不允许包含 <sentra-response>' };
  }

  const fusion = parseSendFusionFromSentraTools(normalized);
  if (!fusion || !Array.isArray(fusion.textSegments) || fusion.textSegments.length === 0) {
    return { valid: false, reason: '缺少 send_fusion 或至少一个 textN 参数' };
  }

  return { valid: true, normalized };
}

function isAllowedPromiseToolsMarkerOutside(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  // Only allow ONE sentra-tools block that contains invoke name="__promise_fulfill__"
  // and nothing else outside <sentra-response>.
  const blocks = s.match(/<sentra-tools>[\s\S]*?<\/sentra-tools>/gi) || [];
  if (blocks.length !== 1) return false;
  const merged = blocks[0].trim();
  if (merged !== s) return false;
  // Promise marker: exactly one <invoke ...> and it contains ONLY one parameter named "reason".
  try {
    const invMatch = merged.match(/<invoke\s+name="[^"]+"\s*>[\s\S]*?<\/invoke>/i);
    if (!invMatch) return false;
    const invokeXml = invMatch[0];
    const names = Array.from(
      invokeXml.matchAll(/<parameter\s+name="([^"]+)">/gi),
      (m) => String(m[1] || '').trim()
    ).filter(Boolean);
    const unique = Array.from(new Set(names));
    if (unique.length !== 1 || unique[0] !== 'reason') return false;
    const allInvokes = merged.match(/<invoke\s+name="[^"]+"\s*>/gi) || [];
    if (allInvokes.length !== 1) return false;
    return true;
  } catch {
    return false;
  }
}

function validateResponseFormat(response, expectedOutput = 'sentra_response') {
  if (expectedOutput === 'reply_gate_decision_tools') {
    return validateReplyGateDecisionToolsFormat(response);
  }

  if (expectedOutput === 'send_fusion_tools') {
    return validateSendFusionToolsFormat(response);
  }

  if (!response || typeof response !== 'string') {
    return { valid: false, reason: '响应为空或非字符串' };
  }

  // Special-case: When we EXPECT <sentra-response> but the model outputs ONLY <sentra-tools>,
  // treat it as a valid "toolsOnly" result and let the upper layer decide how to handle it.
  // This prevents infinite retry loops caused by strict format checks.
  const toolsOnlyXml = extractOnlySentraToolsBlock(response);
  if (toolsOnlyXml) {
    return { valid: true, toolsOnly: true, rawToolsXml: toolsOnlyXml };
  }

  const normalized = extractFirstSentraResponseBlock(response);
  if (!normalized) {
    return { valid: false, reason: '缺少 <sentra-response> 标签' };
  }

  // Enforce: only allow a promise marker outside <sentra-response>
  try {
    const outside = response.replace(normalized, '').trim();
    if (!isAllowedPromiseToolsMarkerOutside(outside)) {
      return {
        valid: false,
        reason: '检测到 <sentra-response> 外存在非允许内容（仅允许 __promise_fulfill__ 的 <sentra-tools> 标记）'
      };
    }
  } catch {}

  const forbiddenTags = [
    '<sentra-tools>',
    '<sentra-result>',
    '<sentra-result-group>',
    '<sentra-user-question>',
    '<sentra-pending-messages>',
    '<sentra-emo>',
    '<sentra-memory>'
  ];

  for (const tag of forbiddenTags) {
    if (normalized.includes(tag)) {
      return { valid: false, reason: `包含非法的只读标签: ${tag}` };
    }
  }

  return { valid: true, normalized };
}

function extractAndCountTokens(response) {
  const textMatches = response.match(/<text\d+>([\s\S]*?)<\/text\d+>/g) || [];
  const texts = textMatches
    .map((match) => {
      const content = match.replace(/<\/?text\d+>/g, '').trim();
      return content;
    })
    .filter(Boolean);

  const combinedText = texts.join(' ');
  const tokens = tokenCounter.countTokens(combinedText, getTokenCountModel());

  return { text: combinedText, tokens };
}

function hasNonTextPayload(response) {
  try {
    const parsed = parseSentraResponse(response);
    const hasResources = parsed && Array.isArray(parsed.resources) && parsed.resources.length > 0;
    const hasEmoji = parsed && parsed.emoji && parsed.emoji.source;
    return !!(hasResources || hasEmoji);
  } catch {
    return false;
  }
}

function buildProtocolReminder() {
  return [
    'CRITICAL OUTPUT RULES:',
    '1) 必须使用 <sentra-response>...</sentra-response> 包裹对用户可见的回复内容',
    '   - 允许额外输出一个 <sentra-tools> 承诺标记（仅限 invoke name="__promise_fulfill__"），但它必须出现在 <sentra-response> 外部',
    '2) 使用分段 <text1>, <text2>, <text3>, <textx>...（每段1句，语气自然）',
    '3) 严禁输出只读输入标签：<sentra-user-question>/<sentra-result>/<sentra-result-group>/<sentra-pending-messages>/<sentra-emo>',
    '4) 不要输出工具或技术术语（如 tool/success/return/data field 等）',
    '5) 文本标签内部不要做 XML 转义（直接输出原始内容），不要把 < 或 > 等字符写成 &lt; / &gt;',
    '6) 禁止使用 ``` 等 markdown 代码块包裹 XML 或任何内容',
    '7) <resources> 可为空；若无资源，输出 <resources></resources>'
  ].join('\n');
}

function buildReplyGateDecisionToolsReminder() {
  return [
    'CRITICAL OUTPUT RULES:',
    '1) 你必须且只能输出一个 <sentra-tools>...</sentra-tools> 决策块，且块内必须包含一个 <invoke name="reply_gate_decision">',
    '2) invoke 必须包含两个参数：enter(boolean) 和 reason(string)',
    '3) 严禁输出 <sentra-response> 或任何额外文本',
    '4) 禁止使用 ``` 等 markdown 代码块包裹 XML'
  ].join('\n');
}

function buildSendFusionToolsReminder() {
  return [
    'CRITICAL OUTPUT RULES:',
    '1) 你必须且只能输出一个 <sentra-tools>...</sentra-tools> 融合块，且块内必须包含一个 <invoke name="send_fusion">',
    '2) invoke 必须包含至少一个参数：text1(string)，可选 text2/text3/...；可额外包含 reason(string)',
    '3) 严禁输出 <sentra-response> 或任何额外文本',
    '4) 禁止使用 ``` 等 markdown 代码块包裹 XML'
  ].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getResponsePreview(payload, limit = 400) {
  if (payload == null) return '[empty]';
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (!text) return '[empty]';
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch (e) {
    return `[unserializable: ${e.message || 'unknown'}]`;
  }
}

export async function chatWithRetry(agent, conversations, modelOrOptions, groupId) {
  let retries = 0;
  let lastError = null;
  let lastResponse = null;
  let lastFormatReason = '';

  const maxResponseRetries = getMaxResponseRetries();
  const maxResponseTokens = getMaxResponseTokens();
  const strictFormatCheck = isStrictFormatCheckEnabled();
  const formatRepairEnabled = isFormatRepairEnabled();

  const options =
    typeof modelOrOptions === 'string'
      ? { model: modelOrOptions }
      : (modelOrOptions || {});

  const expectedOutput = options.__sentraExpectedOutput || 'sentra_response';
  const chatOptions = { ...options };
  delete chatOptions.__sentraExpectedOutput;

  while (retries <= maxResponseRetries) {
    try {
      const attemptIndex = retries + 1;
      logger.debug(`[${groupId}] AI请求第${attemptIndex}次尝试`);

      let convThisTry = conversations;
      if (strictFormatCheck && lastFormatReason) {
        const allowInject =
          lastFormatReason.includes('缺少 <sentra-response> 标签') ||
          lastFormatReason.includes('<sentra-tools>') ||
          lastFormatReason.includes('包含非法的只读标签');
        if (allowInject) {
          const reminder =
            expectedOutput === 'reply_gate_decision_tools'
              ? buildReplyGateDecisionToolsReminder()
              : (expectedOutput === 'send_fusion_tools'
                ? buildSendFusionToolsReminder()
                : buildProtocolReminder());
          convThisTry = Array.isArray(conversations)
            ? [...conversations, { role: 'system', content: reminder }]
            : conversations;
          logger.info(`[${groupId}] 协议复述注入: ${lastFormatReason}`);
        }
      }

      let response = await agent.chat(convThisTry, chatOptions);
      const rawResponse = response;
      lastResponse = response;

      if (strictFormatCheck) {
        const formatCheck = validateResponseFormat(response, expectedOutput);
        if (!formatCheck.valid) {
          lastFormatReason = formatCheck.reason || '';
          logger.warn(`[${groupId}] 格式验证失败: ${formatCheck.reason}`);
          logger.debug(`[${groupId}] 原始响应片段(格式失败): ${getResponsePreview(response)}`);

          if (retries < maxResponseRetries) {
            retries++;
            logger.debug(`[${groupId}] 格式验证失败，直接重试（第${retries + 1}次）...`);
            await sleep(1000);
            continue;
          }

          const isToolsOnly = expectedOutput === 'reply_gate_decision_tools' || expectedOutput === 'send_fusion_tools';
          if (!isToolsOnly && formatRepairEnabled && typeof response === 'string' && response.trim()) {
            try {
              const repaired = await repairSentraResponse(response, {
                agent,
                model: getEnv('REPAIR_AI_MODEL', undefined)
              });
              const repairedCheck = validateResponseFormat(repaired, expectedOutput);
              if (repairedCheck.valid) {
                logger.success(`[${groupId}] 格式已自动修复`);
                return { response: repaired, rawResponse: repaired, retries, success: true };
              }
              logger.debug(`[${groupId}] 修复后仍不合规，修复响应片段: ${getResponsePreview(repaired)}`);
            } catch (e) {
              logger.warn(`[${groupId}] 格式修复失败: ${e.message}`);
            }
          }

          logger.error(`[${groupId}] 格式验证失败-最终: 已达最大重试次数`);
          logger.error(`[${groupId}] 最后原始响应片段: ${getResponsePreview(lastResponse)}`);
          return { response: null, retries, success: false, reason: formatCheck.reason };
        }

        if (formatCheck.toolsOnly) {
          logger.warn(
            `[${groupId}] 期望 <sentra-response> 但收到纯 <sentra-tools>，将上抛 toolsOnly 交由上层回退处理`
          );
          return {
            response: null,
            rawResponse,
            retries,
            success: true,
            toolsOnly: true,
            rawToolsXml: formatCheck.rawToolsXml || rawResponse
          };
        }

        if (formatCheck.normalized && formatCheck.normalized !== response) {
          response = formatCheck.normalized;
          lastResponse = response;
        }
      }

      let tokenText = '';
      if (expectedOutput === 'reply_gate_decision_tools') {
        const decision = parseReplyGateDecisionFromSentraTools(response);
        tokenText = decision && typeof decision.reason === 'string' ? decision.reason : '';
      } else if (expectedOutput === 'send_fusion_tools') {
        const fusion = parseSendFusionFromSentraTools(response);
        tokenText = fusion && Array.isArray(fusion.textSegments) ? fusion.textSegments.join(' ') : '';
      } else {
        tokenText = extractAndCountTokens(response).text;
      }
      const tokens = tokenCounter.countTokens(tokenText || '', getTokenCountModel());
      const text = tokenText || '';
      logger.debug(`[${groupId}] Token统计: ${tokens} tokens, 文本长度: ${text.length}`);

      if (maxResponseTokens > 0 && tokens > maxResponseTokens) {
        logger.warn(`[${groupId}] Token超限: ${tokens} > ${maxResponseTokens}`);
        logger.debug(`[${groupId}] 原始响应片段(Token超限): ${getResponsePreview(response)}`);
        if (retries < maxResponseRetries) {
          retries++;
          logger.debug(`[${groupId}] Token超限，直接重试（第${retries + 1}次）...`);
          await sleep(500);
          continue;
        }
        logger.error(`[${groupId}] Token超限-最终: 已达最大重试次数`);
        logger.error(`[${groupId}] 最后原始响应片段: ${getResponsePreview(lastResponse)}`);
        return {
          response: null,
          retries,
          success: false,
          reason: `Token超限: ${tokens}>${maxResponseTokens}`
        };
      }

      const noReply = (expectedOutput === 'reply_gate_decision_tools' || expectedOutput === 'send_fusion_tools')
        ? false
        : (tokens === 0 && !hasNonTextPayload(response));
      if (noReply) {
        logger.warn(
          `[${groupId}] Token统计为 0，本轮按“保持沉默/不回复”处理（不应向用户发送任何内容）`
        );
      }
      const limitDisplay = maxResponseTokens > 0 ? maxResponseTokens : 'unlimited';
      logger.success(`[${groupId}] AI响应成功 (${tokens}/${limitDisplay} tokens)`);
      return { response, rawResponse, retries, success: true, tokens, text, noReply };
    } catch (error) {
      logger.error(`[${groupId}] AI请求失败 - 第${retries + 1}次尝试`, error);
      lastError = error;
      lastFormatReason = '';
      if (error?.response?.data) {
        logger.error(`[${groupId}] API失败响应体: ${getResponsePreview(error.response.data)}`);
      }
      if (retries < maxResponseRetries) {
        retries++;
        logger.warn(`[${groupId}] 网络错误，1秒后第${retries + 1}次重试...`);
        await sleep(1000);
        continue;
      }
      logger.error(`[${groupId}] AI请求失败 - 已达最大重试次数${maxResponseRetries}次`);
      if (lastResponse) {
        logger.error(`[${groupId}] 最后成功响应片段: ${getResponsePreview(lastResponse)}`);
      }
      return { response: null, retries, success: false, reason: lastError?.message };
    }
  }

  return {
    response: null,
    retries,
    success: false,
    reason: lastError?.message || '未知错误'
  };
}
