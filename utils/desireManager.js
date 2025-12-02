import { getRedis, isRedisReady } from './redisClient.js';
import { getEnv, getEnvInt } from './envHotReloader.js';
import { createLogger } from './logger.js';

const logger = createLogger('DesireManager');

const DEFAULT_PREFIX = getEnv('REDIS_DESIRE_PREFIX', 'sentra:desire:');
const DESIRE_TTL_SECONDS = getEnvInt('DESIRE_TTL_SECONDS', 86400);

const GROUP_SILENT_SEC = getEnvInt('DESIRE_GROUP_SILENT_SEC', 180);
const PRIVATE_SILENT_SEC = getEnvInt('DESIRE_PRIVATE_SILENT_SEC', 120);

const GROUP_MIN_SINCE_USER_SEC = getEnvInt('DESIRE_GROUP_MIN_SINCE_USER_SEC', 60);
const PRIVATE_MIN_SINCE_USER_SEC = getEnvInt('DESIRE_PRIVATE_MIN_SINCE_USER_SEC', 30);

const TRIGGER_THRESHOLD = getEnvInt('DESIRE_TRIGGER_THRESHOLD', 60);
const MAX_PROACTIVE_PER_HOUR = getEnvInt('DESIRE_MAX_PROACTIVE_PER_HOUR', 3);
const BASE_DECAY_PER_MIN = getEnvInt('DESIRE_BASE_DECAY_PER_MIN', 5);

const MSG_WINDOW_SEC = getEnvInt('DESIRE_MSG_WINDOW_SEC', 120);
const GROUP_MAX_MSG_PER_WINDOW = getEnvInt('DESIRE_GROUP_MAX_MSG_PER_WINDOW', 8);
const PRIVATE_MAX_MSG_PER_WINDOW = getEnvInt('DESIRE_PRIVATE_MAX_MSG_PER_WINDOW', 12);

// 主动回复活跃时间段（本地小时 0-23）
const ACTIVE_HOUR_START = getEnvInt('DESIRE_ACTIVE_HOUR_START', 8);
const ACTIVE_HOUR_END = getEnvInt('DESIRE_ACTIVE_HOUR_END', 23);

function getRedisSafe() {
  const r = getRedis();
  if (!r || !isRedisReady()) return null;
  return r;
}

function getBaseState() {
  const now = Date.now();
  return {
    chatType: null,          // 'group' | 'private'
    groupId: null,           // 群ID（字符串）
    userId: null,            // 用户ID（字符串）
    lastUserAt: 0,
    lastBotAt: 0,
    lastProactiveAt: 0,
    desire: 0,
    lastUpdateAt: now,
    msgWindowStart: now,
    msgCount: 0,
    proactiveWindowStart: 0,
    proactiveCount: 0,
    lastMsg: null
  };
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export default class DesireManager {
  constructor(options = {}) {
    this.prefix = options.prefix || DEFAULT_PREFIX;
    this.baseDecayPerMinute = Number.isFinite(options.baseDecayPerMinute)
      ? options.baseDecayPerMinute
      : BASE_DECAY_PER_MIN;
    this.groupSilentSec = Number.isFinite(options.groupSilentSec)
      ? options.groupSilentSec
      : GROUP_SILENT_SEC;
    this.privateSilentSec = Number.isFinite(options.privateSilentSec)
      ? options.privateSilentSec
      : PRIVATE_SILENT_SEC;
    this.triggerThreshold = Number.isFinite(options.triggerThreshold)
      ? options.triggerThreshold
      : TRIGGER_THRESHOLD;
    this.maxProactivePerHour = Number.isFinite(options.maxProactivePerHour)
      ? options.maxProactivePerHour
      : MAX_PROACTIVE_PER_HOUR;

    this.msgWindowSec = Number.isFinite(options.msgWindowSec)
      ? options.msgWindowSec
      : MSG_WINDOW_SEC;
    this.groupMaxMsgPerWindow = Number.isFinite(options.groupMaxMsgPerWindow)
      ? options.groupMaxMsgPerWindow
      : GROUP_MAX_MSG_PER_WINDOW;
    this.privateMaxMsgPerWindow = Number.isFinite(options.privateMaxMsgPerWindow)
      ? options.privateMaxMsgPerWindow
      : PRIVATE_MAX_MSG_PER_WINDOW;

    this.localCache = new Map(); // Map<conversationKey, state>
  }

  _buildConversationKey(msg) {
    const userid = String(msg?.sender_id ?? '');
    if (msg?.group_id) {
      return `G:${msg.group_id}`;
    }
    return `U:${userid}`;
  }

  _makeKey(conversationKey) {
    return `${this.prefix}${conversationKey}`;
  }

  async _loadState(conversationKey) {
    const existing = this.localCache.get(conversationKey);
    if (existing) {
      return { ...getBaseState(), ...existing };
    }

    const redis = getRedisSafe();
    if (!redis) {
      const base = getBaseState();
      this.localCache.set(conversationKey, base);
      return base;
    }

    const key = this._makeKey(conversationKey);
    try {
      const raw = await redis.get(key);
      if (!raw) {
        const base = getBaseState();
        this.localCache.set(conversationKey, base);
        return base;
      }
      const parsed = JSON.parse(raw);
      const base = getBaseState();
      const merged = { ...base, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
      this.localCache.set(conversationKey, merged);
      return merged;
    } catch (e) {
      logger.warn('DesireManager _loadState from Redis failed, fallback to base', {
        key,
        err: String(e)
      });
      const base = getBaseState();
      this.localCache.set(conversationKey, base);
      return base;
    }
  }

  async _saveState(conversationKey, state) {
    const normalized = { ...getBaseState(), ...(state || {}) };
    this.localCache.set(conversationKey, normalized);

    const redis = getRedisSafe();
    if (!redis) return;

    const key = this._makeKey(conversationKey);
    try {
      const payload = JSON.stringify(normalized);
      if (Number.isFinite(DESIRE_TTL_SECONDS) && DESIRE_TTL_SECONDS > 0) {
        await redis.set(key, payload, 'EX', DESIRE_TTL_SECONDS);
      } else {
        await redis.set(key, payload);
      }
    } catch (e) {
      logger.warn('DesireManager _saveState to Redis failed (ignored)', {
        key,
        err: String(e)
      });
    }
  }

  _computeScore(state, now) {
    const chatType = state.chatType || 'group';
    const lastUserAt = state.lastUserAt || 0;
    const lastBotAt = state.lastBotAt || 0;
    const lastProactiveAt = state.lastProactiveAt || 0;

    const sinceUserSec = lastUserAt ? (now - lastUserAt) / 1000 : Infinity;
    const sinceBotSec = lastBotAt ? (now - lastBotAt) / 1000 : Infinity;
    const sinceProactiveSec = lastProactiveAt ? (now - lastProactiveAt) / 1000 : Infinity;

    const msgCount = state.msgCount || 0;
    const hourNow = new Date(now).getHours();

    let score = 0;

    // 1. 冷场程度：用户与机器人的静默时长
    const baseMinSinceUser =
      chatType === 'group' ? GROUP_MIN_SINCE_USER_SEC : PRIVATE_MIN_SINCE_USER_SEC;
    const baseSilentSec =
      chatType === 'group'
        ? this.groupSilentSec || GROUP_SILENT_SEC
        : this.privateSilentSec || PRIVATE_SILENT_SEC;

    if (sinceUserSec >= baseMinSinceUser && Number.isFinite(sinceUserSec)) {
      const upper = baseSilentSec * 2 || baseMinSinceUser * 2 || 1;
      const norm = clamp(
        (sinceUserSec - baseMinSinceUser) / Math.max(upper - baseMinSinceUser, 1),
        0,
        1
      );
      score += norm * 40; // 0-40 分：越久没人说话越容易触发
    }

    if (sinceBotSec >= baseSilentSec && Number.isFinite(sinceBotSec)) {
      const denom = baseSilentSec * 4 || 1;
      const norm = clamp((sinceBotSec - baseSilentSec) / denom, 0, 1);
      score += 10 + norm * 10; // 10-20 分：机器人越久没说话，越有理由主动
    }

    // 2. 最近一小段时间的消息频率：适度活跃更适合主动插话
    const maxMsg =
      chatType === 'group'
        ? this.groupMaxMsgPerWindow || GROUP_MAX_MSG_PER_WINDOW
        : this.privateMaxMsgPerWindow || PRIVATE_MAX_MSG_PER_WINDOW;

    if (msgCount === 0) {
      // 完全无历史互动：不额外加分，交给其他因素
    } else if (msgCount <= maxMsg / 2) {
      score += 15; // 轻度活跃后冷场：比较适合来一句
    } else if (msgCount <= maxMsg) {
      score += 5; // 稍微热闹，但还没到高频刷屏
    }

    // 3. 时间段：避免深夜打扰，非活跃时间整体降权
    let activeStart = ACTIVE_HOUR_START;
    let activeEnd = ACTIVE_HOUR_END;
    if (!Number.isFinite(activeStart)) activeStart = 8;
    if (!Number.isFinite(activeEnd)) activeEnd = 23;

    let isActiveHour;
    if (activeStart === activeEnd) {
      // 等于表示全天都视为活跃
      isActiveHour = true;
    } else if (activeStart < activeEnd) {
      isActiveHour = hourNow >= activeStart && hourNow < activeEnd;
    } else {
      // 处理例如 22-6 这种跨午夜区间
      isActiveHour = hourNow >= activeStart || hourNow < activeEnd;
    }

    if (isActiveHour) {
      score += 10;
    } else {
      score -= 20;
    }

    // 4. 最近主动频率惩罚：一小时内刚主动过则明显降权
    if (Number.isFinite(sinceProactiveSec) && sinceProactiveSec < 3600) {
      const norm = clamp((3600 - sinceProactiveSec) / 3600, 0, 1);
      score -= norm * 30;
    }

    return score;
  }

  async onUserMessage(msg) {
    if (!msg) return;
    const conversationKey = this._buildConversationKey(msg);
    let state = await this._loadState(conversationKey);
    const now = Date.now();

    state.chatType = msg.type === 'group' ? 'group' : 'private';
    if (msg.group_id) {
      state.groupId = String(msg.group_id);
    }
    if (msg.sender_id != null) {
      state.userId = String(msg.sender_id);
    }

    state.lastUserAt = now;
    state.lastMsg = msg;

    // 更新消息频率窗口
    if (!state.msgWindowStart || !Number.isFinite(state.msgWindowStart)) {
      state.msgWindowStart = now;
      state.msgCount = 1;
    } else {
      const windowMs = (this.msgWindowSec || MSG_WINDOW_SEC) * 1000;
      if (now - state.msgWindowStart > windowMs) {
        state.msgWindowStart = now;
        state.msgCount = 1;
      } else {
        state.msgCount = (state.msgCount || 0) + 1;
      }
    }

    state.lastUpdateAt = now;

    await this._saveState(conversationKey, state);
  }

  async onBotMessage(msg, options = {}) {
    if (!msg) return;
    const conversationKey = this._buildConversationKey(msg);
    let state = await this._loadState(conversationKey);
    const now = Date.now();

    const proactive = !!options.proactive;

    state.lastBotAt = now;
    if (proactive) {
      state.lastProactiveAt = now;
      // 每小时频率窗口
      const hourMs = 60 * 60 * 1000;
      if (!state.proactiveWindowStart || now - state.proactiveWindowStart > hourMs) {
        state.proactiveWindowStart = now;
        state.proactiveCount = 1;
      } else {
        state.proactiveCount = (state.proactiveCount || 0) + 1;
      }
      // 主动触发后，当前会话的欲望值直接清零，由后续时间衰减/增强重新累积
      state.desire = 0;
    }

    state.lastUpdateAt = now;
    await this._saveState(conversationKey, state);
  }

  async tick(now = Date.now()) {
    const updates = [];
    for (const [conversationKey, stateRaw] of this.localCache.entries()) {
      const state = { ...getBaseState(), ...(stateRaw || {}) };
      const lastUpdate = Number.isFinite(state.lastUpdateAt) ? state.lastUpdateAt : now;
      const deltaMs = now - lastUpdate;
      if (!Number.isFinite(deltaMs) || deltaMs <= 0) continue;

      const minutes = deltaMs / 60000;
      const decayPerMin = this.baseDecayPerMinute || BASE_DECAY_PER_MIN;
      let changed = false;

      const currentDesire = Number.isFinite(state.desire) ? state.desire : 0;
      let nextDesire = currentDesire;

      // 1. 时间衰减：长时间未更新时，逐步降低欲望值
      if (decayPerMin > 0 && currentDesire > 0 && minutes > 0) {
        const decayed = currentDesire - decayPerMin * minutes;
        nextDesire = decayed < 0 ? 0 : decayed;
        changed = true;
      }

      // 2. 时间增强：在符合冷场等条件且综合得分较高时，缓慢积累欲望
      //    这样不会因为单次瞬时状态就立刻触发，而是需要一段时间持续冷场
      const scoreNow = this._computeScore(state, now);
      const thresholdBase = this.triggerThreshold || TRIGGER_THRESHOLD;
      if (scoreNow > thresholdBase / 2 && minutes > 0) {
        const rawGain = (scoreNow - thresholdBase / 2) * minutes;
        const difficulty = 1 + (state.proactiveCount || 0); // 主动次数越多，后续越难再次积累
        const gain = rawGain > 0 && difficulty > 0 ? rawGain / difficulty : 0;
        if (gain > 0) {
          const maxDesire = thresholdBase * 3; // 上限做个保护，避免无限增长
          nextDesire = nextDesire + gain;
          if (nextDesire > maxDesire) {
            nextDesire = maxDesire;
          }
          changed = true;
        }
      }

      if (changed) {
        state.desire = nextDesire;
        state.lastUpdateAt = now;
        updates.push(this._saveState(conversationKey, state));
      }
    }

    if (updates.length > 0) {
      await Promise.allSettled(updates);
    }
  }

  async collectProactiveCandidates(now = Date.now()) {
    const result = [];
    const hourMs = 60 * 60 * 1000;

    for (const [conversationKey, stateRaw] of this.localCache.entries()) {
      const state = { ...getBaseState(), ...(stateRaw || {}) };

      const chatType = state.chatType || 'group';
      const lastUserAt = state.lastUserAt || 0;
      const lastBotAt = state.lastBotAt || 0;

      const sinceUser = lastUserAt ? now - lastUserAt : Infinity;
      const sinceBot = lastBotAt ? now - lastBotAt : Infinity;

      // 频率窗口
      const windowMs = (this.msgWindowSec || MSG_WINDOW_SEC) * 1000;
      let msgCount = state.msgCount || 0;
      if (state.msgWindowStart && now - state.msgWindowStart > windowMs) {
        msgCount = 0;
      }

      // 每小时主动次数限制
      const windowStart = state.proactiveWindowStart || 0;
      const withinHour = windowStart && now - windowStart < hourMs;
      const proactiveCount = state.proactiveCount || 0;
      if (withinHour && proactiveCount >= this.maxProactivePerHour) {
        continue;
      }

      if (chatType === 'group') {
        const silentSec = this.groupSilentSec || GROUP_SILENT_SEC;
        const minSinceUser = GROUP_MIN_SINCE_USER_SEC;
        const maxMsg = this.groupMaxMsgPerWindow || GROUP_MAX_MSG_PER_WINDOW;

        if (sinceBot < silentSec * 1000) continue;
        if (sinceUser < minSinceUser * 1000) continue;
        if (msgCount > maxMsg) continue; // 频率过高，不主动插话
      } else {
        const silentSec = this.privateSilentSec || PRIVATE_SILENT_SEC;
        const minSinceUser = PRIVATE_MIN_SINCE_USER_SEC;
        const maxMsg = this.privateMaxMsgPerWindow || PRIVATE_MAX_MSG_PER_WINDOW;

        if (sinceBot < silentSec * 1000) continue;
        if (sinceUser < minSinceUser * 1000) continue;
        if (msgCount > maxMsg) continue;
      }

      if (!state.lastMsg) {
        continue;
      }

      // 经过上述硬性约束后，根据冷场程度 / 时间段 / 频率等综合打分，再结合时间累计的 desire 决定是否入队
      const score = this._computeScore(state, now);
      const desire = Number.isFinite(state.desire) ? state.desire : 0;
      const thresholdBase = this.triggerThreshold || TRIGGER_THRESHOLD;

      // 要求：
      //  - 当前综合得分不能太低（仍需满足冷场/时间段等即时条件）
      //  - 时间累计后的欲望值必须超过触发阈值
      if (score < thresholdBase / 2) {
        continue;
      }
      if (desire < thresholdBase) {
        continue;
      }

      this.localCache.set(conversationKey, state);

      logger.debug('DesireManager: proactive candidate selected', {
        conversationKey,
        chatType,
        score,
        desire,
        msgCount,
        sinceUser,
        sinceBot,
        proactiveCount
      });

      result.push({
        conversationKey,
        chatType,
        groupId: state.groupId,
        userId: state.userId,
        lastMsg: state.lastMsg,
        desireScore: desire
      });
    }

    return result;
  }
}
