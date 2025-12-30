/**
 * 智能回复策略模块（精简版）
 * 功能：
 * - Per-sender 并发控制和队列机制
 * - UUID 跟踪和超时淘汰
 * - 是否进入一次对话任务由本模块决定，具体“回不回话”交给主模型和 Sentra 协议（<sentra-response>）
 */

import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';
import { planGroupReplyDecision } from './replyIntervention.js';
import { assessReplyWorth } from '../components/ReplyGate.js';
import { loadAttentionStats, updateAttentionStatsAfterDecision } from './attentionStats.js';
import { getEnv, getEnvInt, getEnvBool } from './envHotReloader.js';

const logger = createLogger('ReplyPolicy');

const senderQueues = new Map();
const activeTasks = new Map();
const groupAttention = new Map();
const senderReplyStats = new Map(); // senderId -> { timestamps: number[] }
const groupReplyStats = new Map();  // groupKey -> { timestamps: number[] }
const cancelledTasks = new Set();   // 记录被标记为取消的任务ID（taskId）
const gateSessions = new Map();

const senderLastTouchedAt = new Map();

function touchSenderState(senderKey) {
  const k = normalizeSenderId(senderKey);
  if (!k) return;
  senderLastTouchedAt.set(k, Date.now());
}

function pruneReplyPolicyState() {
  const ttlMsRaw = getEnvInt('REPLY_POLICY_STATE_TTL_MS', 30 * 60 * 1000);
  const ttlMs = Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : 30 * 60 * 1000;
  const maxCancelledRaw = getEnvInt('CANCELLED_TASKS_MAX', 5000);
  const maxCancelled = Number.isFinite(maxCancelledRaw) && maxCancelledRaw > 0 ? maxCancelledRaw : 5000;

  const now = Date.now();

  for (const [senderKey, ts] of senderLastTouchedAt.entries()) {
    if (!Number.isFinite(ts) || now - ts <= ttlMs) continue;

    const q = senderQueues.get(senderKey);
    const a = activeTasks.get(senderKey);

    const hasQueue = Array.isArray(q) && q.length > 0;
    const hasActive = a && a instanceof Set && a.size > 0;

    if (!hasQueue && !hasActive) {
      senderQueues.delete(senderKey);
      activeTasks.delete(senderKey);
      gateSessions.delete(senderKey);
      senderReplyStats.delete(senderKey);
      senderLastTouchedAt.delete(senderKey);
    }
  }

  for (const [groupKey, map] of groupAttention.entries()) {
    if (!map || !(map instanceof Map)) {
      groupAttention.delete(groupKey);
      continue;
    }
    for (const [sid, ts] of map.entries()) {
      if (!Number.isFinite(ts) || now - ts > 10 * 60 * 1000) {
        map.delete(sid);
      }
    }
    if (map.size === 0) {
      groupAttention.delete(groupKey);
    }
  }

  if (cancelledTasks.size > maxCancelled) {
    cancelledTasks.clear();
  }
}

try {
  const intervalMsRaw = getEnvInt('REPLY_POLICY_PRUNE_INTERVAL_MS', 60000);
  const intervalMs = Number.isFinite(intervalMsRaw) && intervalMsRaw > 0 ? intervalMsRaw : 60000;
  const timer = setInterval(() => {
    try { pruneReplyPolicyState(); } catch {}
  }, intervalMs);
  timer.unref?.();
} catch {}

const REPLY_GATE_BASE_ZH = {
  reply_gate_disabled: 'ReplyGate 已关闭：跳过本地预判，交给 LLM 决策',
  non_group_message: '非群聊消息：ReplyGate 不参与（由上层策略处理）',
  empty_text: '空文本：群消息没有可分析的文本内容',
  analyzer_error: '本地分析器异常：已回退为 LLM 决策',
  policy_blocked: '合规策略拦截：检测到风险内容，本轮不进入回复流程',
  below_min_threshold: '价值极低：低于最小阈值，本轮直接忽略',
  pass_to_llm: '通过本地预判：进入 LLM 决策阶段'
};

const REPLY_GATE_REASON_CODE_ZH = {
  EMPTY_OR_INVALID_INPUT: '空内容或非法输入',
  TEXT_TOO_SHORT: '文本过短（信息量不足）',
  LOW_ENTROPY_GIBBERISH: '疑似乱码/灌水（熵过低）',
  TOO_FEW_TOKENS: '有效词过少（信息量不足）',
  LOW_SEMANTIC_VALUE: '语义信息量低（缺少明确意图）',
  POLICY_BLOCKED: '合规拦截（辱骂/敏感/风险内容）',
  POLICY_FLAGGED: '合规提示（存在轻度风险内容）',
  HARD_REPEAT_SHRINK: '高度重复：与近期内容相似度过高，回复概率被强力下调',
  REPETITIVE_CONTENT: '重复内容：与历史消息过于相似',
  LOW_REPLY_PROBABILITY: '回复价值低：综合评估后概率偏低'
};

function parseReplyGateReason(reason) {
  const raw = typeof reason === 'string' ? reason : String(reason ?? '');
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length < 2) return null;
  const subsystem = parts[0] || '';
  if (subsystem !== 'conversation_analyzer') return null;
  const base = parts[1] || '';
  const suffix = parts.slice(2).join(':');
  const codes = suffix ? suffix.split('|').map((s) => s.trim()).filter(Boolean) : [];
  const baseZh = REPLY_GATE_BASE_ZH[base] || base;
  const codesZh = codes.map((c) => REPLY_GATE_REASON_CODE_ZH[c] || c);
  return { subsystem, base, baseZh, codes, codesZh, raw };
}

function buildReplyGateExplainZh(gateResult) {
  const parsed = parseReplyGateReason(gateResult?.reason);
  if (!parsed) {
    return {
      summary: typeof gateResult?.reason === 'string' ? gateResult.reason : String(gateResult?.reason ?? ''),
      parsed: null
    };
  }
  const detail = parsed.codesZh.length ? `；细项：${parsed.codesZh.join('；')}` : '';
  let policyDetail = '';
  const policy = gateResult?.debug?.analyzer?.policy;
  if (policy && typeof policy === 'object' && policy.action) {
    const details = Array.isArray(policy.details) ? policy.details : [];
    const brief = details
      .map((d) => {
        if (!d || typeof d !== 'object') return '';
        const kind = d.kind ? String(d.kind) : '';
        const score = typeof d.score === 'number' && Number.isFinite(d.score) ? d.score : null;
        const matches = typeof d.matches === 'number' && Number.isFinite(d.matches) ? d.matches : null;
        const bits = [];
        if (kind) bits.push(kind);
        if (score != null) bits.push(`score=${score.toFixed(3)}`);
        if (matches != null) bits.push(`matches=${matches}`);
        return bits.join(',');
      })
      .filter(Boolean)
      .slice(0, 4);
    if (brief.length) {
      policyDetail = `；合规细节：${brief.join(' | ')}`;
    }
  }
  return {
    summary: `${parsed.baseZh}${detail}${policyDetail}`,
    parsed
  };
}

/**
 * 任务状态
 */
class Task {
  constructor(msg, conversationId) {
    this.id = randomUUID();
    this.msg = msg;
    this.conversationId = conversationId;
    this.createdAt = Date.now();
    this.senderId = String(msg.sender_id);
  }
}

function normalizeSenderId(senderId) {
  return String(senderId ?? '');
}

function buildConversationId(msg, senderId) {
  const sid = normalizeSenderId(senderId ?? (msg && msg.sender_id));
  if (msg && msg.group_id) {
    return `group_${msg.group_id}_sender_${sid}`;
  }
  return `private_${sid}`;
}

function getGroupKey(groupId) {
  return `G:${groupId ?? ''}`;
}

function resetGateSessionForConversationId(conversationId) {
  const key = normalizeSenderId(conversationId);
  if (!key) return;
  const session = gateSessions.get(key);
  if (session) {
    session.value = 0;
    session.lastTs = 0;
  }
}

function updateGateSessionAndCheck(msg, senderId, config, gateProb, activeCount) {
  if (!msg || msg.type !== 'group' || !msg.group_id) return true;
  if (!Number.isFinite(gateProb) || gateProb <= 0) return true;

  const baseline = Number.isFinite(config.replyGateAccumBaseline)
    ? config.replyGateAccumBaseline
    : 0.15;
  const threshold = Number.isFinite(config.replyGateAccumThreshold)
    ? config.replyGateAccumThreshold
    : 1.0;
  const halflifeMs = Number.isFinite(config.replyGateAccumHalflifeMs) && config.replyGateAccumHalflifeMs > 0
    ? config.replyGateAccumHalflifeMs
    : 180000;

  const eff = gateProb - baseline;
  const now = Date.now();
  const key = buildConversationId(msg, senderId);
  let session = gateSessions.get(key);
  if (!session) {
    session = { value: 0, lastTs: now };
    gateSessions.set(key, session);
  }

  const lastTs = Number.isFinite(session.lastTs) && session.lastTs > 0 ? session.lastTs : now;
  let value = Number.isFinite(session.value) ? session.value : 0;
  const dt = now - lastTs;
  if (dt > 0 && halflifeMs > 0) {
    const decay = Math.pow(0.5, dt / halflifeMs);
    value *= decay;
  }
  if (eff > 0) {
    value += eff;
  }

  session.value = value;
  session.lastTs = now;

  if (value < threshold) {
    return false;
  }

  if (activeCount > 0) {
    session.value = 0;
    session.lastTs = now;
    return false;
  }

  session.value = 0;
  session.lastTs = now;
  return true;
}

function getOrInitSenderStats(senderId) {
  const key = normalizeSenderId(senderId);
  if (!senderReplyStats.has(key)) {
    senderReplyStats.set(key, { timestamps: [] });
  }
  return senderReplyStats.get(key);
}

function getOrInitGroupStats(groupId) {
  const key = getGroupKey(groupId);
  if (!groupReplyStats.has(key)) {
    groupReplyStats.set(key, { timestamps: [] });
  }
  return groupReplyStats.get(key);
}

function pruneTimestamps(timestamps, now, windowMs) {
  if (!Array.isArray(timestamps) || !windowMs || windowMs <= 0) {
    return { list: [], count: 0, last: null };
  }
  const list = [];
  let last = null;
  for (const t of timestamps) {
    if (now - t <= windowMs) {
      list.push(t);
      last = t;
    }
  }
  return { list, count: list.length, last };
}

function shouldPassAttentionWindow(msg, senderId, config, options = {}) {
  if (!config.attentionEnabled) return true;
  if (!msg || !msg.group_id) return true;
  const maxSenders = config.attentionMaxSenders;
  const windowMs = config.attentionWindowMs;
  if (!maxSenders || maxSenders <= 0) return true;
  if (!windowMs || windowMs <= 0) return true;

  const groupKey = getGroupKey(msg.group_id);
  const now = Date.now();
  let map = groupAttention.get(groupKey);
  if (!map) {
    map = new Map();
    groupAttention.set(groupKey, map);
  }

  for (const [sid, ts] of map.entries()) {
    if (now - ts > windowMs) {
      map.delete(sid);
    }
  }

  if (map.size < maxSenders) {
    return true;
  }

  if (map.has(senderId)) {
    return true;
  }

  if (options.isExplicitMention) {
    return true;
  }

  return false;
}

function isSenderInAttentionList(msg, senderId, config) {
  if (!config.attentionEnabled) return true;
  if (!msg || !msg.group_id) return true;
  const maxSenders = config.attentionMaxSenders;
  const windowMs = config.attentionWindowMs;
  if (!maxSenders || maxSenders <= 0) return true;
  if (!windowMs || windowMs <= 0) return true;

  const groupKey = getGroupKey(msg.group_id);
  const now = Date.now();
  let map = groupAttention.get(groupKey);
  if (!map) {
    return false;
  }

  for (const [sid, ts] of map.entries()) {
    if (now - ts > windowMs) {
      map.delete(sid);
    }
  }

  return map.has(senderId);
}

function markAttentionWindow(msg, senderId, config) {
  if (!config.attentionEnabled) return;
  if (!msg || !msg.group_id) return;
  const maxSenders = config.attentionMaxSenders;
  const windowMs = config.attentionWindowMs;
  if (!maxSenders || maxSenders <= 0) return;
  if (!windowMs || windowMs <= 0) return;

  const groupKey = getGroupKey(msg.group_id);
  let map = groupAttention.get(groupKey);
  if (!map) {
    map = new Map();
    groupAttention.set(groupKey, map);
  }
  map.set(senderId, Date.now());
}

function evaluateGroupFatigue(msg, config, options = {}) {
  const result = { pass: true, reason: '', count: 0, fatigue: 0, lastAgeSec: null };
  if (!config.groupFatigueEnabled) return result;
  if (!msg || msg.type !== 'group' || !msg.group_id) return result;

  const windowMs = config.groupReplyWindowMs;
  const baseLimit = config.groupReplyBaseLimit;
  const minInterval = config.groupReplyMinIntervalMs;
  let factor = Number.isFinite(config.groupReplyBackoffFactor) ? config.groupReplyBackoffFactor : 2;
  let maxMult = Number.isFinite(config.groupReplyMaxBackoffMultiplier) ? config.groupReplyMaxBackoffMultiplier : 8;
  if (!windowMs || windowMs <= 0 || !baseLimit || baseLimit <= 0 || !minInterval || minInterval <= 0) {
    return result;
  }
  if (!Number.isFinite(factor) || factor <= 1) factor = 2;
  if (!Number.isFinite(maxMult) || maxMult <= 1) maxMult = 8;

  const now = Date.now();
  const stats = getOrInitGroupStats(msg.group_id);
  const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
  stats.timestamps = pruned.list;
  result.count = pruned.count;
  result.lastAgeSec = pruned.last ? (now - pruned.last) / 1000 : null;

  if (pruned.count === 0 || !pruned.last) {
    result.fatigue = 0;
    return result;
  }

  const ratio = pruned.count / baseLimit;
  const clipped = Math.min(Math.max(ratio, 0), 2);
  result.fatigue = clipped / 2; // 映射到 0-1

  if (ratio <= 1) {
    return result;
  }

  const overload = Math.max(0, Math.floor(pruned.count - baseLimit));
  const mult = Math.min(Math.pow(factor, overload), maxMult);
  const requiredInterval = minInterval * mult;
  const elapsed = now - pruned.last;

  const isImportant = !!options.isExplicitMention || !!options.mentionedByName;
  if (!isImportant && elapsed < requiredInterval) {
    result.pass = false;
    result.reason = '群疲劳：短期内机器人在该群回复过多，进入退避窗口';
    return result;
  }

  return result;
}

function evaluateSenderFatigue(msg, senderId, config, options = {}) {
  const result = { pass: true, reason: '', count: 0, fatigue: 0, lastAgeSec: null };
  if (!config.userFatigueEnabled) return result;
  if (!msg || msg.type !== 'group') return result;

  const windowMs = config.userReplyWindowMs;
  const baseLimit = config.userReplyBaseLimit;
  const minInterval = config.userReplyMinIntervalMs;
  let factor = Number.isFinite(config.userReplyBackoffFactor) ? config.userReplyBackoffFactor : 2;
  let maxMult = Number.isFinite(config.userReplyMaxBackoffMultiplier) ? config.userReplyMaxBackoffMultiplier : 8;
  if (!windowMs || windowMs <= 0 || !baseLimit || baseLimit <= 0 || !minInterval || minInterval <= 0) {
    return result;
  }
  if (!Number.isFinite(factor) || factor <= 1) factor = 2;
  if (!Number.isFinite(maxMult) || maxMult <= 1) maxMult = 8;

  const now = Date.now();
  const stats = getOrInitSenderStats(senderId);
  const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
  stats.timestamps = pruned.list;
  result.count = pruned.count;
  result.lastAgeSec = pruned.last ? (now - pruned.last) / 1000 : null;

  if (pruned.count === 0 || !pruned.last) {
    result.fatigue = 0;
    return result;
  }

  const ratio = pruned.count / baseLimit;
  const clipped = Math.min(Math.max(ratio, 0), 2);
  result.fatigue = clipped / 2; // 映射到 0-1

  if (ratio <= 1) {
    return result;
  }

  const overload = Math.max(0, Math.floor(pruned.count - baseLimit));
  const mult = Math.min(Math.pow(factor, overload), maxMult);
  const requiredInterval = minInterval * mult;
  const elapsed = now - pruned.last;

  const isImportant = !!options.isExplicitMention || !!options.mentionedByName;
  if (!isImportant && elapsed < requiredInterval) {
    result.pass = false;
    result.reason = '用户疲劳：短期内机器人对该用户回复过多，进入退避窗口';
    return result;
  }

  return result;
}

function recordReplyForFatigue(msg, senderId, config) {
  if (!msg || msg.type !== 'group') return;
  const now = Date.now();

  if (config.userFatigueEnabled) {
    const windowMs = config.userReplyWindowMs;
    if (windowMs && windowMs > 0) {
      const stats = getOrInitSenderStats(senderId);
      const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
      pruned.list.push(now);
      stats.timestamps = pruned.list;
    }
  }

  if (config.groupFatigueEnabled && msg.group_id) {
    const windowMs = config.groupReplyWindowMs;
    if (windowMs && windowMs > 0) {
      const stats = getOrInitGroupStats(msg.group_id);
      const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
      pruned.list.push(now);
      stats.timestamps = pruned.list;
    }
  }
}

/**
 * 获取或创建用户队列
 */
function getSenderQueue(senderId) {
  const key = normalizeSenderId(senderId);
  touchSenderState(key);
  if (!senderQueues.has(key)) {
    senderQueues.set(key, []);
  }
  return senderQueues.get(key);
}

/**
 * 获取用户当前活跃任务数
 */
export function getActiveTaskCount(senderId) {
  const key = normalizeSenderId(senderId);
  touchSenderState(key);
  if (!activeTasks.has(key)) {
    activeTasks.set(key, new Set());
  }
  return activeTasks.get(key).size;
}

function getActiveTaskSet(senderId) {
  const key = normalizeSenderId(senderId);
  touchSenderState(key);
  if (!activeTasks.has(key)) {
    activeTasks.set(key, new Set());
  }
  return activeTasks.get(key);
}

export function markTasksCancelledForSender(senderId) {
  const set = getActiveTaskSet(senderId);
  if (!set || set.size === 0) {
    return;
  }
  for (const taskId of set) {
    if (taskId) {
      cancelledTasks.add(taskId);
    }
  }
  const shortIds = Array.from(set).map((id) => (id ? String(id).substring(0, 8) : 'null'));
  logger.info(`标记取消任务: sender=${normalizeSenderId(senderId)}, tasks=[${shortIds.join(',')}]`);
}

export function isTaskCancelled(taskId) {
  if (!taskId) return false;
  return cancelledTasks.has(taskId);
}

export function clearCancelledTask(taskId) {
  if (!taskId) return;
  cancelledTasks.delete(taskId);
}

export function resetReplyGateForSender(senderId) {
  if (!senderId) return;
  resetGateSessionForConversationId(senderId);
}

/**
 * 添加活跃任务
 */
function addActiveTask(senderId, taskId) {
  const key = normalizeSenderId(senderId);
  touchSenderState(key);
  if (!activeTasks.has(key)) {
    activeTasks.set(key, new Set());
  }
  activeTasks.get(key).add(taskId);
  logger.debug(`活跃任务+: ${key} 添加任务 ${taskId?.substring(0,8)}, 当前活跃数: ${activeTasks.get(key).size}`);
  resetGateSessionForConversationId(senderId);
}

/**
 * 移除活跃任务并尝试处理队列
 */
function removeActiveTask(senderId, taskId) {
  const key = normalizeSenderId(senderId);
  touchSenderState(key);
  if (activeTasks.has(key)) {
    activeTasks.get(key).delete(taskId);
    logger.debug(`活跃任务-: ${key} 移除任务 ${taskId?.substring(0,8)}, 剩余活跃数: ${activeTasks.get(key).size}`);
  }
}

/**
 * 解析环境变量中的bot名称列表
 */
function parseBotNames() {
  const names = getEnv('BOT_NAMES', '');
  if (!names.trim()) return [];
  return names.split(',').map(n => n.trim()).filter(Boolean);
}

/**
 * 解析配置参数
 */
function getConfig() {
  const botNames = parseBotNames();
  const attentionWindowMsEnv = getEnvInt('ATTENTION_WINDOW_MS', 120000);
  const attentionMaxSendersEnv = getEnvInt('ATTENTION_MAX_SENDERS', 3);
  const attentionWindowMs = Number.isFinite(attentionWindowMsEnv) ? attentionWindowMsEnv : 120000;
  const attentionMaxSenders = Number.isFinite(attentionMaxSendersEnv) ? attentionMaxSendersEnv : 3;
  const followupWindowSecEnv = getEnvInt('REPLY_DECISION_FOLLOWUP_WINDOW_SEC', 180);
  const replyFollowupWindowSec = Number.isFinite(followupWindowSecEnv) && followupWindowSecEnv > 0
    ? followupWindowSecEnv
    : 0;
  return {
    // bot 名称列表（支持多个昵称，仅用于简单“是否被提及”的判断）
    botNames,
    // Per-sender 最大并发数
    maxConcurrentPerSender: getEnvInt('MAX_CONCURRENT_PER_SENDER', 1),
    // 队列任务最大等待时间（毫秒）
    queueTimeout: getEnvInt('QUEUE_TIMEOUT', 30000),
    // 显式 @ 是否必须回复（true=显式 @ 一律回复；false=交给模型和人设决定）
    mentionMustReply: getEnvBool('MENTION_MUST_REPLY', false),
    pureLocalGating: getEnvBool('PURE_LOCAL_REPLY_GATING', true),
    replyFollowupWindowSec,
    attentionEnabled: getEnvBool('ATTENTION_WINDOW_ENABLED', true),
    attentionWindowMs,
    attentionMaxSenders,
    // 群/用户疲劳控制（短期窗口 + 指数退避）
    userFatigueEnabled: getEnvBool('USER_FATIGUE_ENABLED', true),
    userReplyWindowMs: getEnvInt('USER_REPLY_WINDOW_MS', 300000),
    userReplyBaseLimit: getEnvInt('USER_REPLY_BASE_LIMIT', 5),
    userReplyMinIntervalMs: getEnvInt('USER_REPLY_MIN_INTERVAL_MS', 10000),
    userReplyBackoffFactor: parseFloat(getEnv('USER_REPLY_BACKOFF_FACTOR', '2')),
    userReplyMaxBackoffMultiplier: parseFloat(getEnv('USER_REPLY_MAX_BACKOFF_MULTIPLIER', '8')),
    groupFatigueEnabled: getEnvBool('GROUP_FATIGUE_ENABLED', true),
    groupReplyWindowMs: getEnvInt('GROUP_REPLY_WINDOW_MS', 300000),
    groupReplyBaseLimit: getEnvInt('GROUP_REPLY_BASE_LIMIT', 30),
    groupReplyMinIntervalMs: getEnvInt('GROUP_REPLY_MIN_INTERVAL_MS', 2000),
    groupReplyBackoffFactor: parseFloat(getEnv('GROUP_REPLY_BACKOFF_FACTOR', '2')),
    groupReplyMaxBackoffMultiplier: parseFloat(getEnv('GROUP_REPLY_MAX_BACKOFF_MULTIPLIER', '8')),
    replyGateAccumBaseline: parseFloat(getEnv('REPLY_GATE_ACCUM_BASELINE', '0.15')),
    replyGateAccumThreshold: parseFloat(getEnv('REPLY_GATE_ACCUM_THRESHOLD', '1.0')),
    replyGateAccumHalflifeMs: getEnvInt('REPLY_GATE_ACCUM_HALFLIFE_MS', 180000)
  };
}

/**
 * 处理队列中的待定任务
 */
async function processQueue(senderId) {
  const config = getConfig();
  const queue = getSenderQueue(senderId);
  
  // 只补充一个任务，由上层驱动继续触发
  if (getActiveTaskCount(senderId) < config.maxConcurrentPerSender && queue.length > 0) {
    const task = queue.shift();
    
    // 检查是否超时
    const age = Date.now() - task.createdAt;
    if (age > config.queueTimeout) {
      logger.warn(`队列超时: 任务 ${task.id} 等待${age}ms，已放弃`);
      return null;
    }
    
    // 执行任务
    logger.debug(`队列补充: 任务 ${task.id} 开始处理`);
    addActiveTask(senderId, task.id);
    // 返回给上层处理
    return task;
  }
  return null;
}

/**
 * 完成任务（供外部调用）
 */
export async function completeTask(senderId, taskId) {
  removeActiveTask(senderId, taskId);
  logger.debug(`任务完成: sender=${normalizeSenderId(senderId)}, task=${taskId}`);
  const next = await processQueue(senderId);
  return next;
}

/**
 * 智能回复决策 v2.0
 * @param {Object} msg - 消息对象
 * @returns {Promise<{needReply: boolean, reason: string, mandatory: boolean, probability: number, taskId: string|null}>}
 */
export async function shouldReply(msg, options = {}) {
  const config = getConfig();
  const senderIdRaw = normalizeSenderId(msg.sender_id);
  const decisionContext = options.decisionContext || null;
  const source = options && typeof options.source === 'string' ? options.source : '';

  const conversationId = buildConversationId(msg, senderIdRaw);
  const senderKey = conversationId;
  // 私聊：保持必回策略
  if (msg.type === 'private') {
    const taskId = randomUUID();
    addActiveTask(senderKey, taskId);
    logger.info(`私聊消息，必须回复 (task=${taskId})`);
    return {
      needReply: true,
      reason: '私聊消息',
      explainZh: '私聊消息：默认必回',
      decisionSource: 'local_private',
      mandatory: true,
      probability: 1.0,
      taskId
    };
  }

  // 群聊：并发和队列控制 + 轻量 LLM 决策是否回复
  const activeCount = getActiveTaskCount(senderKey);

  if (activeCount >= config.maxConcurrentPerSender) {
    const task = new Task(msg, conversationId);
    const queue = getSenderQueue(senderKey);
    queue.push(task);
    logger.debug(`并发限制: sender=${senderKey} 活跃=${activeCount}/${config.maxConcurrentPerSender}, 队列长度=${queue.length}`);
    return {
      needReply: false,
      reason: '并发限制，已加入队列',
      explainZh: '并发限制：当前会话已有任务在处理，消息已进入队列等待',
      decisionSource: 'local_concurrency_queue',
      mandatory: false,
      probability: 0.0,
      taskId: null
    };
  }

  const isGroup = msg.type === 'group';
  const selfId = msg.self_id;
  let attentionSession = null;
  if (isGroup && msg.group_id) {
    try {
      const stats = await loadAttentionStats(msg.group_id, senderIdRaw);
      if (stats && typeof stats === 'object') {
        const considered = Number.isFinite(stats.consideredCount) ? stats.consideredCount : 0;
        const replied = Number.isFinite(stats.repliedCount) ? stats.repliedCount : 0;
        const avgAnalyzerProb =
          considered > 0 && typeof stats.sumAnalyzerProb === 'number'
            ? stats.sumAnalyzerProb / considered
            : null;
        const avgGateProb =
          considered > 0 && typeof stats.sumGateProb === 'number'
            ? stats.sumGateProb / considered
            : null;
        const avgFusedProb =
          considered > 0 && typeof stats.sumFusedProb === 'number'
            ? stats.sumFusedProb / considered
            : null;
        const replyRatio = considered > 0 ? (replied / considered) : null;
        attentionSession = {
          consideredCount: considered,
          repliedCount: replied,
          avgAnalyzerProb,
          avgGateProb,
          avgFusedProb,
          replyRatio
        };
      }
    } catch (e) {
      logger.debug(`loadAttentionStats 失败: group ${msg.group_id} sender ${senderIdRaw}`, {
        err: String(e)
      });
    }
  }
  const isExplicitMention = Array.isArray(msg.at_users) && msg.at_users.some(at => String(at) === String(selfId));
  const groupInfo = msg.group_id ? `群${msg.group_id}` : '私聊';

  // 基于 BOT_NAMES 的名称提及检测（仅作为信号，不做硬编码规则）
  let mentionedByName = false;
  const mentionedNames = [];
  if (isGroup && Array.isArray(config.botNames) && config.botNames.length > 0) {
    const textForMatch = ((msg.text || msg.summary || '') + '').toLowerCase();
    if (textForMatch) {
      for (const name of config.botNames) {
        const n = (name || '').toLowerCase();
        if (!n) continue;
        if (textForMatch.includes(n)) {
          mentionedByName = true;
          mentionedNames.push(name);
        }
      }
    }
  }

  let inAttentionList = true;
  if (isGroup && msg.group_id) {
    inAttentionList = isSenderInAttentionList(msg, senderIdRaw, config);
    if (!inAttentionList && !isExplicitMention && !mentionedByName) {
      const reason = '群监听队列外且未提及Bot，跳过本轮群聊消息';
      logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${reason}`);
      return {
        needReply: false,
        reason,
        explainZh: '注意力名单未覆盖该发送者，且未@/未提及机器人名称：跳过本轮消息',
        decisionSource: 'local_attention_list',
        mandatory: false,
        probability: 0.0,
        conversationId,
        taskId: null
      };
    }
  }

  if (isGroup) {
    const pass = shouldPassAttentionWindow(msg, senderIdRaw, config, {
      isExplicitMention: isExplicitMention || mentionedByName
    });
    if (!pass) {
      const reason = '注意力窗口已满，跳过本轮群聊消息';
      logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${reason}`);
      return {
        needReply: false,
        reason,
        explainZh: '注意力窗口已满：当前时间窗内活跃发送者过多，为避免刷屏本轮跳过',
        decisionSource: 'local_attention_window',
        mandatory: false,
        probability: 0.0,
        conversationId,
        taskId: null
      };
    }
  }
  let senderFatigueInfo = { count: 0, fatigue: 0, lastAgeSec: null };
  let groupFatigueInfo = { count: 0, fatigue: 0, lastAgeSec: null };
  let senderFatiguePass = true;
  let senderFatigueReason = '';
  let groupFatiguePass = true;
  let groupFatigueReason = '';

  if (isGroup) {
    const gf = evaluateGroupFatigue(msg, config, {
      isExplicitMention,
      mentionedByName
    });
    groupFatigueInfo = { count: gf.count, fatigue: gf.fatigue, lastAgeSec: gf.lastAgeSec };
    groupFatiguePass = !!gf.pass;
    groupFatigueReason = gf.reason || '';

    const uf = evaluateSenderFatigue(msg, senderIdRaw, config, {
      isExplicitMention,
      mentionedByName
    });
    senderFatigueInfo = { count: uf.count, fatigue: uf.fatigue, lastAgeSec: uf.lastAgeSec };
    senderFatiguePass = !!uf.pass;
    senderFatigueReason = uf.reason || '';
    logger.debug(
      `[${groupInfo}] 疲劳统计: groupCount=${groupFatigueInfo.count}, groupFatigue=${groupFatigueInfo.fatigue.toFixed(2)}, senderCount=${senderFatigueInfo.count}, senderFatigue=${senderFatigueInfo.fatigue.toFixed(2)}, senderLastReplyAgeSec=${senderFatigueInfo.lastAgeSec ?? 'null'}`
    );
  }

  let isFollowupAfterBotReply = false;
  if (
    typeof senderFatigueInfo.lastAgeSec === 'number' &&
    senderFatigueInfo.lastAgeSec >= 0 &&
    Number.isFinite(config.replyFollowupWindowSec) &&
    config.replyFollowupWindowSec > 0
  ) {
    isFollowupAfterBotReply = senderFatigueInfo.lastAgeSec <= config.replyFollowupWindowSec;
  }

  if (isGroup && config.pureLocalGating) {
    if (!groupFatiguePass) {
      const fatigueReason = groupFatigueReason || '群疲劳：短期内机器人在该群回复过多，进入退避窗口';
      logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${fatigueReason}`);
      return {
        needReply: false,
        reason: fatigueReason,
        explainZh: fatigueReason,
        decisionSource: 'local_group_fatigue',
        mandatory: false,
        probability: 0.0,
        conversationId,
        taskId: null
      };
    }
    if (!senderFatiguePass) {
      const fatigueReason = senderFatigueReason || '用户疲劳：短期内机器人对该用户回复过多，进入退避窗口';
      logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${fatigueReason}`);
      return {
        needReply: false,
        reason: fatigueReason,
        explainZh: fatigueReason,
        decisionSource: 'local_sender_fatigue',
        mandatory: false,
        probability: 0.0,
        conversationId,
        taskId: null
      };
    }
  }

  const policyConfig = {
    mentionMustReply: !!config.mentionMustReply,
    followupWindowSec: Number.isFinite(config.replyFollowupWindowSec)
      ? config.replyFollowupWindowSec
      : 0,
    attention: {
      enabled: !!config.attentionEnabled,
      windowMs: config.attentionWindowMs,
      maxSenders: config.attentionMaxSenders
    },
    userFatigue: {
      enabled: !!config.userFatigueEnabled,
      windowMs: config.userReplyWindowMs,
      baseLimit: config.userReplyBaseLimit,
      minIntervalMs: config.userReplyMinIntervalMs,
      backoffFactor: config.userReplyBackoffFactor,
      maxBackoffMultiplier: config.userReplyMaxBackoffMultiplier
    },
    groupFatigue: {
      enabled: !!config.groupFatigueEnabled,
      windowMs: config.groupReplyWindowMs,
      baseLimit: config.groupReplyBaseLimit,
      minIntervalMs: config.groupReplyMinIntervalMs,
      backoffFactor: config.groupReplyBackoffFactor,
      maxBackoffMultiplier: config.groupReplyMaxBackoffMultiplier
    }
  };

  let probability = 1.0;
  let gateProb = null;
  let reason = isGroup ? '群聊消息' : '消息';
  let mandatory = false;
  let shouldReplyFlag = true;
  let gateResult = null;
  let explainZh = '';
  let decisionSource = 'local_policy';
  const decisionTrace = {
    source,
    isGroup,
    isExplicitMention,
    mentionedByName: !!mentionedByName,
    isFollowupAfterBotReply,
    pureLocalGating: !!config.pureLocalGating,
    useLlmIntervention: null,
    gate: null,
    gateAccum: null,
    llmDecision: null
  };

  // 群聊 + 非显式 @ 的消息先通过 ReplyGate 进行价值预判：
  //  - decision = 'ignore'  => 直接不回
  //  - decision = 'llm'     => 继续交给 XML 决策 LLM
  if (isGroup && !isExplicitMention && !mentionedByName) {
    try {
      gateResult = assessReplyWorth(
        msg,
        {
          mentionedByAt: isExplicitMention,
          mentionedByName,
          senderReplyCountWindow: senderFatigueInfo.count,
          groupReplyCountWindow: groupFatigueInfo.count,
          senderFatigue: senderFatigueInfo.fatigue,
          groupFatigue: groupFatigueInfo.fatigue,
          isFollowupAfterBotReply,
          attentionSession
        },
        {
          decisionContext
        }
      );

      if (gateResult && typeof gateResult.normalizedScore === 'number' && Number.isFinite(gateResult.normalizedScore)) {
        decisionTrace.gate = {
          decision: gateResult.decision,
          normalizedScore: gateResult.normalizedScore,
          reason: gateResult.reason,
          analyzerProb:
            gateResult.debug && gateResult.debug.analyzer && typeof gateResult.debug.analyzer.probability === 'number'
              ? gateResult.debug.analyzer.probability
              : null
        };
      }

      if (gateResult && gateResult.decision === 'ignore') {
        const gateReason = `ReplyGate: ${gateResult.reason || 'low_interest_score'}`;
        const explain = buildReplyGateExplainZh(gateResult);
        explainZh = explain?.summary || '';
        decisionSource = 'local_reply_gate';
        const gateProbPercent =
          typeof gateResult.normalizedScore === 'number' && Number.isFinite(gateResult.normalizedScore)
            ? (gateResult.normalizedScore * 100).toFixed(1)
            : '0.0';
        const analyzerProbPercent =
          gateResult.debug && gateResult.debug.analyzer && typeof gateResult.debug.analyzer.probability === 'number'
            ? (gateResult.debug.analyzer.probability * 100).toFixed(1)
            : 'null';

        logger.info(
          `[${groupInfo}] 用户${senderIdRaw} 预判为不回复: ${explainZh || '本地门禁判定无需回复'} (gateProb=${gateProbPercent}%, analyzerProb=${analyzerProbPercent}%, raw=${gateReason})`
        );
        if (isGroup && msg.group_id) {
          try {
            let analyzerProb = null;
            if (
              gateResult.debug &&
              gateResult.debug.analyzer &&
              typeof gateResult.debug.analyzer.probability === 'number'
            ) {
              analyzerProb = gateResult.debug.analyzer.probability;
            }
            const gateP =
              typeof gateResult.normalizedScore === 'number' && Number.isFinite(gateResult.normalizedScore)
                ? gateResult.normalizedScore
                : null;
            await updateAttentionStatsAfterDecision({
              groupId: msg.group_id,
              senderId: senderIdRaw,
              analyzerProb,
              gateProb: gateP,
              fusedProb: 0,
              didReply: false
            });
          } catch (e) {
            logger.debug(`updateAttentionStatsAfterDecision 失败: group ${msg.group_id} sender ${senderIdRaw}`, {
              err: String(e)
            });
          }
        }
        return {
          needReply: false,
          reason: gateReason,
          explainZh: explainZh || undefined,
          decisionSource,
          decisionTrace,
          mandatory: false,
          probability: gateResult.normalizedScore ?? 0,
          conversationId,
          taskId: null
        };
      }
      // 其余情况（包括 gateResult.decision === 'llm' 或 gateResult 为空，
      // 以及 follow-up 但未被 policy_blocked 的 decision === 'ignore'）
      // 继续走后面的 planGroupReplyDecision XML 决策，并保留 gate 概率用于后续融合
      if (gateResult && typeof gateResult.normalizedScore === 'number' && Number.isFinite(gateResult.normalizedScore)) {
        const p = gateResult.normalizedScore;
        gateProb = p < 0 ? 0 : p > 1 ? 1 : p;
        if (config.pureLocalGating && !isFollowupAfterBotReply) {
          probability = gateProb;
        }
      }
    } catch (e) {
      logger.debug(`ReplyGate 预判失败，回退为正常 LLM 决策: ${groupInfo} sender ${senderIdRaw}`, {
        err: String(e)
      });
    }
  }

  if (isGroup && msg.group_id && !isExplicitMention && !mentionedByName && gateProb != null) {
    // 对于来自延迟聚合（改意愿后合并）的新意图，放宽 ReplyGateAccum：
    // - 仍然更新 attentionStats 统计
    // - 但不以 "below_threshold_or_busy" 作为硬门禁，避免用户明确改意愿后再次被吞掉
    const skipAccumThrottling = source === 'pending_merged' || isFollowupAfterBotReply;

    if (!skipAccumThrottling) {
      const allowByAccum = updateGateSessionAndCheck(msg, senderIdRaw, config, gateProb, activeCount);
      if (!allowByAccum) {
        decisionTrace.gateAccum = { allow: false, gateProb };
        try {
          let analyzerProb = null;
          if (
            gateResult &&
            gateResult.debug &&
            gateResult.debug.analyzer &&
            typeof gateResult.debug.analyzer.probability === 'number'
          ) {
            analyzerProb = gateResult.debug.analyzer.probability;
          }
          await updateAttentionStatsAfterDecision({
            groupId: msg.group_id,
            senderId: senderIdRaw,
            analyzerProb,
            gateProb,
            fusedProb: 0,
            didReply: false
          });
        } catch (e) {
          logger.debug(`updateAttentionStatsAfterDecision 失败: group ${msg.group_id} sender ${senderIdRaw}`, {
            err: String(e)
          });
        }
        const reasonAccum = 'ReplyGateAccum: below_threshold_or_busy';
        explainZh = '聚合门禁未通过：近期多条低价值消息累计不足阈值，或当前已有任务在处理（避免刷屏）';
        decisionSource = 'local_reply_gate_accum';
        logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${explainZh} (raw=${reasonAccum}, gateProb=${(gateProb * 100).toFixed(1)}%)`);
        return {
          needReply: false,
          reason: reasonAccum,
          explainZh,
          decisionSource,
          decisionTrace,
          mandatory: false,
          probability: gateProb,
          conversationId,
          taskId: null
        };
      }
    } else {
      decisionTrace.gateAccum = { allow: true, gateProb, skip: true };
      // 仅记录一次统计，表明在高负载/节流场景下仍然尊重用户新的明确意图
      try {
        let analyzerProb = null;
        if (
          gateResult &&
          gateResult.debug &&
          gateResult.debug.analyzer &&
          typeof gateResult.debug.analyzer.probability === 'number'
        ) {
          analyzerProb = gateResult.debug.analyzer.probability;
        }
        await updateAttentionStatsAfterDecision({
          groupId: msg.group_id,
          senderId: senderIdRaw,
          analyzerProb,
          gateProb,
          fusedProb: probability,
          didReply: true
        });
      } catch (e) {
        logger.debug(`updateAttentionStatsAfterDecision 失败: group ${msg.group_id} sender ${senderIdRaw}`, {
          err: String(e)
        });
      }
      logger.info(`[${groupInfo}] 延迟聚合场景放宽 ReplyGateAccum: sender=${senderIdRaw}, gateProb=${gateProb}`);
    }
  }

  const useLlmIntervention = isGroup && (!config.pureLocalGating || isExplicitMention || mentionedByName || isFollowupAfterBotReply);
  decisionTrace.useLlmIntervention = useLlmIntervention;

  logger.debug(
    `[${groupInfo}] 决策路径: useLlm=${useLlmIntervention} (pureLocalGating=${!!config.pureLocalGating}, explicitAt=${isExplicitMention}, mentionedByName=${!!mentionedByName}, followup=${isFollowupAfterBotReply}, source=${source || 'direct'})`
  );

  if (useLlmIntervention) {
    decisionSource = 'llm_reply_intervention';
    const intervention = await planGroupReplyDecision(msg, {
      signals: {
        mentionedByAt: isExplicitMention,
        mentionedByName,
        mentionedNames,
        senderReplyCountWindow: senderFatigueInfo.count,
        groupReplyCountWindow: groupFatigueInfo.count,
        senderFatigue: senderFatigueInfo.fatigue,
        groupFatigue: groupFatigueInfo.fatigue,
        senderLastReplyAgeSec: senderFatigueInfo.lastAgeSec,
        groupLastReplyAgeSec: groupFatigueInfo.lastAgeSec,
        isFollowupAfterBotReply,
        activeTaskCount: activeCount
      },
      context: decisionContext || undefined,
      policy: policyConfig
    });

    if (intervention && typeof intervention.shouldReply === 'boolean') {
      shouldReplyFlag = intervention.shouldReply;
      decisionTrace.llmDecision = {
        shouldReply: shouldReplyFlag,
        confidence:
          typeof intervention.confidence === 'number' && Number.isFinite(intervention.confidence)
            ? intervention.confidence
            : null,
        reason: typeof intervention.reason === 'string' ? intervention.reason : null
      };

      let interventionConfidence;
      if (typeof intervention.confidence === 'number' && Number.isFinite(intervention.confidence)) {
        const c = intervention.confidence;
        interventionConfidence = c < 0 ? 0 : c > 1 ? 1 : c;
      } else {
        interventionConfidence = shouldReplyFlag ? 1.0 : 0.0;
      }

      probability = interventionConfidence;
      reason = intervention.reason
        ? `ReplyIntervention: ${intervention.reason}`
        : (shouldReplyFlag
            ? 'ReplyIntervention: LLM 判定应进入主对话流程'
            : 'ReplyIntervention: LLM 判定本轮不进入主对话流程');

      if (typeof intervention.reason === 'string' && intervention.reason.trim()) {
        explainZh = `LLM 决策：${intervention.reason.trim()}`;
      } else {
        explainZh = shouldReplyFlag
          ? 'LLM 决策：建议进入主对话流程'
          : 'LLM 决策：建议本轮不进入主对话流程';
      }
    }
  }

  if (isGroup && isExplicitMention && config.mentionMustReply) {
    if (!shouldReplyFlag) {
      logger.info('当前决策判定无需回复，但配置要求对显式@必须回复，强制覆盖为需要回复');
    }
    shouldReplyFlag = true;
    mandatory = true;
    reason = '显式@（配置必须回复）';
    explainZh = '显式@且配置要求必须回复：强制覆盖为需要回复';
    decisionSource = 'local_mandatory_mention';
    probability = 1.0;
  }

  if (isGroup && msg.group_id) {
    try {
      let analyzerProb = null;
      if (
        gateResult &&
        gateResult.debug &&
        gateResult.debug.analyzer &&
        typeof gateResult.debug.analyzer.probability === 'number'
      ) {
        analyzerProb = gateResult.debug.analyzer.probability;
      }
      await updateAttentionStatsAfterDecision({
        groupId: msg.group_id,
        senderId: senderIdRaw,
        analyzerProb,
        gateProb,
        fusedProb: probability,
        didReply: shouldReplyFlag
      });
    } catch (e) {
      logger.debug(`updateAttentionStatsAfterDecision 失败: group ${msg.group_id} sender ${senderIdRaw}`, {
        err: String(e)
      });
    }
  }

  if (!shouldReplyFlag) {
    const zh = explainZh || (typeof reason === 'string' ? reason : '本轮不回复');
    logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${zh} (raw=${reason}, p=${(probability * 100).toFixed(1)}%, src=${decisionSource})`);
    return {
      needReply: false,
      reason,
      explainZh: zh,
      decisionSource,
      decisionTrace,
      mandatory: false,
      probability,
      conversationId,
      taskId: null
    };
  }

  const taskId = randomUUID();
  addActiveTask(senderKey, taskId);
  if (isGroup) {
    markAttentionWindow(msg, senderIdRaw, config);
    recordReplyForFatigue(msg, senderIdRaw, config);
  }
  if (!explainZh) {
    explainZh = typeof reason === 'string' ? reason : '进入主对话流程';
  }
  logger.info(
    `[${groupInfo}] 用户${senderIdRaw} 启动对话: ${explainZh} (raw=${reason}, mandatory=${mandatory}, p=${(probability * 100).toFixed(1)}%, src=${decisionSource}, task=${taskId})`
  );

  return {
    needReply: true,
    reason,
    explainZh,
    decisionSource,
    decisionTrace,
    mandatory,
    probability,
    conversationId,
    taskId
  };
}
