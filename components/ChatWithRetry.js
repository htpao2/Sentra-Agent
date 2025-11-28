import { createLogger } from '../utils/logger.js';
import { tokenCounter } from '../src/token-counter.js';
import { repairSentraResponse } from '../utils/formatRepair.js';
import { getEnv, getEnvInt, getEnvBool } from '../utils/envHotReloader.js';

const logger = createLogger('ChatWithRetry');

function getMaxResponseRetries() {
  return getEnvInt('MAX_RESPONSE_RETRIES', 2);
}

function getMaxResponseTokens() {
  return getEnvInt('MAX_RESPONSE_TOKENS', 260);
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

function validateResponseFormat(response) {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: '响应为空或非字符串' };
  }

  if (!response.includes('<sentra-response>')) {
    return { valid: false, reason: '缺少 <sentra-response> 标签' };
  }

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
    if (response.includes(tag)) {
      return { valid: false, reason: `包含非法的只读标签: ${tag}` };
    }
  }

  return { valid: true };
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

function buildProtocolReminder() {
  return [
    'CRITICAL OUTPUT RULES:',
    '1) 必须使用 <sentra-response>...</sentra-response> 包裹整个回复',
    '2) 使用分段 <text1>, <text2>, <text3>, <textx>...（每段1句，语气自然）',
    '3) 严禁输出只读输入标签：<sentra-user-question>/<sentra-result>/<sentra-result-group>/<sentra-pending-messages>/<sentra-emo>',
    '4) 不要输出工具或技术术语（如 tool/success/return/data field 等）',
    '5) 文本标签内部不要做 XML 转义（直接输出原始内容）',
    '6) <resources> 可为空；若无资源，输出 <resources></resources>'
  ].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  while (retries <= maxResponseRetries) {
    try {
      const attemptIndex = retries + 1;
      logger.debug(`[${groupId}] AI请求第${attemptIndex}次尝试`);

      let convThisTry = conversations;
      if (strictFormatCheck && lastFormatReason) {
        const allowInject =
          lastFormatReason.includes('缺少 <sentra-response> 标签') ||
          lastFormatReason.includes('包含非法的只读标签');
        if (allowInject) {
          const reminder = buildProtocolReminder();
          convThisTry = Array.isArray(conversations)
            ? [...conversations, { role: 'system', content: reminder }]
            : conversations;
          logger.info(`[${groupId}] 协议复述注入: ${lastFormatReason}`);
        }
      }

      let response = await agent.chat(convThisTry, options);
      lastResponse = response;

      if (strictFormatCheck) {
        const formatCheck = validateResponseFormat(response);
        if (!formatCheck.valid) {
          lastFormatReason = formatCheck.reason || '';
          logger.warn(`[${groupId}] 格式验证失败: ${formatCheck.reason}`);

          if (retries < maxResponseRetries) {
            retries++;
            logger.debug(`[${groupId}] 格式验证失败，直接重试（第${retries + 1}次）...`);
            await sleep(1000);
            continue;
          }

          if (formatRepairEnabled && typeof response === 'string' && response.trim()) {
            try {
              const repaired = await repairSentraResponse(response, {
                agent,
                model: getEnv('REPAIR_AI_MODEL', undefined)
              });
              const repairedCheck = validateResponseFormat(repaired);
              if (repairedCheck.valid) {
                logger.success(`[${groupId}] 格式已自动修复`);
                return { response: repaired, retries, success: true };
              }
            } catch (e) {
              logger.warn(`[${groupId}] 格式修复失败: ${e.message}`);
            }
          }

          logger.error(`[${groupId}] 格式验证失败-最终: 已达最大重试次数`);
          return { response: null, retries, success: false, reason: formatCheck.reason };
        }
      }

      const { text, tokens } = extractAndCountTokens(response);
      logger.debug(`[${groupId}] Token统计: ${tokens} tokens, 文本长度: ${text.length}`);

      if (tokens > maxResponseTokens) {
        logger.warn(`[${groupId}] Token超限: ${tokens} > ${maxResponseTokens}`);
        if (retries < maxResponseRetries) {
          retries++;
          logger.debug(`[${groupId}] Token超限，直接重试（第${retries + 1}次）...`);
          await sleep(500);
          continue;
        }
        logger.error(`[${groupId}] Token超限-最终: 已达最大重试次数`);
        return {
          response: null,
          retries,
          success: false,
          reason: `Token超限: ${tokens}>${maxResponseTokens}`
        };
      }

      logger.success(`[${groupId}] AI响应成功 (${tokens}/${maxResponseTokens} tokens)`);
      return { response, retries, success: true };
    } catch (error) {
      logger.error(`[${groupId}] AI请求失败 - 第${retries + 1}次尝试`, error);
      lastError = error;
      lastFormatReason = '';
      if (retries < maxResponseRetries) {
        retries++;
        logger.warn(`[${groupId}] 网络错误，1秒后第${retries + 1}次重试...`);
        await sleep(1000);
        continue;
      }
      logger.error(`[${groupId}] AI请求失败 - 已达最大重试次数${maxResponseRetries}次`);
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
