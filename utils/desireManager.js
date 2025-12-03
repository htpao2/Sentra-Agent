import { getRedis, isRedisReady } from './redisClient.js';
import { getEnv, getEnvInt, getEnvBool } from './envHotReloader.js';
import { createLogger } from './logger.js';

const logger = createLogger('DesireManager');

const DEFAULT_PREFIX = getEnv('REDIS_DESIRE_PREFIX', 'sentra:desire:');
const DESIRE_TTL_SECONDS = getEnvInt('DESIRE_TTL_SECONDS', 86400);

const GROUP_SILENT_SEC = getEnvInt('DESIRE_GROUP_SILENT_SEC', 180);
const PRIVATE_SILENT_SEC = getEnvInt('DESIRE_PRIVATE_SILENT_SEC', 120);

const GROUP_MIN_SINCE_USER_SEC = getEnvInt('DESIRE_GROUP_MIN_SINCE_USER_SEC', 60);
const PRIVATE_MIN_SINCE_USER_SEC = getEnvInt('DESIRE_PRIVATE_MIN_SINCE_USER_SEC', 30);

const MAX_PROACTIVE_PER_HOUR = getEnvInt('DESIRE_MAX_PROACTIVE_PER_HOUR', 3);

const MSG_WINDOW_SEC = getEnvInt('DESIRE_MSG_WINDOW_SEC', 120);
const GROUP_MAX_MSG_PER_WINDOW = getEnvInt('DESIRE_GROUP_MAX_MSG_PER_WINDOW', 8);
const PRIVATE_MAX_MSG_PER_WINDOW = getEnvInt('DESIRE_PRIVATE_MAX_MSG_PER_WINDOW', 12);

// 主动回复活跃时间段（本地小时 0-23）
const ACTIVE_HOUR_START = getEnvInt('DESIRE_ACTIVE_HOUR_START', 8);
const ACTIVE_HOUR_END = getEnvInt('DESIRE_ACTIVE_HOUR_END', 23);

const PROACTIVE_INTENSITY = Number.parseFloat(getEnv('DESIRE_PROACTIVE_INTENSITY', '1'));

const USER_FATIGUE_ENABLED = getEnvBool('DESIRE_USER_FATIGUE_ENABLED', true);
const USER_FATIGUE_RESPONSE_WINDOW_SEC = getEnvInt('DESIRE_USER_FATIGUE_RESPONSE_WINDOW_SEC', 300);
const USER_FATIGUE_MAX_STRIKES = getEnvInt('DESIRE_USER_FATIGUE_MAX_STRIKES', 3);
const USER_FATIGUE_PENALTY_FACTOR = Number.parseFloat(
  getEnv('DESIRE_USER_FATIGUE_PENALTY_FACTOR', '0.2')
);
const USER_FATIGUE_PENALTY_DURATION_SEC = getEnvInt(
  'DESIRE_USER_FATIGUE_PENALTY_DURATION_SEC',
  3600
);
const USER_FATIGUE_TTL_SECONDS = getEnvInt('DESIRE_USER_FATIGUE_TTL_SECONDS', 86400);
const USER_FATIGUE_PREFIX = getEnv('REDIS_DESIRE_USER_FATIGUE_PREFIX', 'sentra:desire:user:');

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
    this.groupSilentSec = Number.isFinite(options.groupSilentSec)
      ? options.groupSilentSec
      : GROUP_SILENT_SEC;
    this.privateSilentSec = Number.isFinite(options.privateSilentSec)
      ? options.privateSilentSec
      : PRIVATE_SILENT_SEC;
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

  _makeUserFatigueKey(userId) {
    if (!userId) return null;
    return `${USER_FATIGUE_PREFIX}${userId}`;
  }

  async _loadUserFatigue(userId) {
    const key = this._makeUserFatigueKey(userId);
    const base = { strikes: 0, lastProactiveAt: 0, lastUserReplyAt: 0, penaltyUntil: 0 };

    if (!key) {
      return { ...base };
    }

    const redis = getRedisSafe();
    if (!redis) {
      return { ...base };
    }

    try {
      const raw = await redis.get(key);
      if (!raw) {
        return { ...base };
      }
      const parsed = JSON.parse(raw);
      const merged = { ...base, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
      return {
        strikes: Number.isFinite(merged.strikes) ? merged.strikes : 0,
        lastProactiveAt: Number.isFinite(merged.lastProactiveAt) ? merged.lastProactiveAt : 0,
        lastUserReplyAt: Number.isFinite(merged.lastUserReplyAt) ? merged.lastUserReplyAt : 0,
        penaltyUntil: Number.isFinite(merged.penaltyUntil) ? merged.penaltyUntil : 0
      };
    } catch (e) {
      logger.debug('DesireManager: load user fatigue failed, fallback to base', {
        userId,
        err: String(e)
      });
      return { ...base };
    }
  }

  async _saveUserFatigue(userId, state) {
    const key = this._makeUserFatigueKey(userId);
    if (!key) return;

    const redis = getRedisSafe();
    if (!redis) return;

    const base = { strikes: 0, lastProactiveAt: 0, lastUserReplyAt: 0, penaltyUntil: 0 };
    const normalized = { ...base, ...(state || {}) };

    try {
      const payload = JSON.stringify(normalized);
      const ttl = Number.isFinite(USER_FATIGUE_TTL_SECONDS) && USER_FATIGUE_TTL_SECONDS > 0
        ? USER_FATIGUE_TTL_SECONDS
        : 0;
      if (ttl > 0) {
        await redis.set(key, payload, 'EX', ttl);
      } else {
        await redis.set(key, payload);
      }
    } catch (e) {
      logger.debug('DesireManager: save user fatigue failed (ignored)', {
        userId,
        err: String(e)
      });
    }
  }

  async _updateUserFatigueOnUserMessage(userId, now) {
    if (!USER_FATIGUE_ENABLED || !userId) return;

    const windowSec = Math.max(0, USER_FATIGUE_RESPONSE_WINDOW_SEC || 0);
    const windowMs = windowSec * 1000;
    const nowMs = now;

    const state = await this._loadUserFatigue(userId);
    const lastProactiveAt = Number.isFinite(state.lastProactiveAt) ? state.lastProactiveAt : 0;

    state.lastUserReplyAt = nowMs;

    if (lastProactiveAt > 0 && windowMs > 0) {
      const delta = nowMs - lastProactiveAt;
      if (delta >= 0 && delta <= windowMs) {
        state.strikes = 0;
        state.penaltyUntil = 0;
      }
    }

    await this._saveUserFatigue(userId, state);
  }

  async _updateUserFatigueOnProactive(userId, now) {
    if (!USER_FATIGUE_ENABLED || !userId) return;

    const windowSec = Math.max(0, USER_FATIGUE_RESPONSE_WINDOW_SEC || 0);
    const windowMs = windowSec * 1000;
    const nowMs = now;
    const maxStrikes = Math.max(1, USER_FATIGUE_MAX_STRIKES || 1);

    const state = await this._loadUserFatigue(userId);
    const lastProactiveAt = Number.isFinite(state.lastProactiveAt) ? state.lastProactiveAt : 0;
    const lastUserReplyAt = Number.isFinite(state.lastUserReplyAt) ? state.lastUserReplyAt : 0;

    if (lastProactiveAt > 0 && windowMs > 0) {
      const repliedInWindow =
        lastUserReplyAt >= lastProactiveAt && lastUserReplyAt - lastProactiveAt <= windowMs;
      const episodeFinished = nowMs - lastProactiveAt >= windowMs;

      if (repliedInWindow) {
        state.strikes = 0;
        state.penaltyUntil = 0;
      } else if (episodeFinished) {
        state.strikes = (state.strikes || 0) + 1;
      }
    }

    if (state.strikes >= maxStrikes) {
      const penaltyDurationSec = Math.max(0, USER_FATIGUE_PENALTY_DURATION_SEC || 0);
      const penaltyDurationMs = penaltyDurationSec * 1000;
      if (penaltyDurationMs > 0) {
        const candidateUntil = nowMs + penaltyDurationMs;
        const currentUntil = Number.isFinite(state.penaltyUntil) ? state.penaltyUntil : 0;
        state.penaltyUntil = Math.max(currentUntil, candidateUntil);
      }
    }

    state.strikes = Math.max(0, state.strikes || 0);
    state.lastProactiveAt = nowMs;

    await this._saveUserFatigue(userId, state);
  }

  async _getUserFatigueFactor(userId, now, cache) {
    if (!USER_FATIGUE_ENABLED || !userId) {
      return 1;
    }

    if (cache && cache.has(userId)) {
      return cache.get(userId);
    }

    const state = await this._loadUserFatigue(userId);
    const nowMs = now;
    const penaltyUntil = Number.isFinite(state.penaltyUntil) ? state.penaltyUntil : 0;
    const strikes = Number.isFinite(state.strikes) ? state.strikes : 0;
    const maxStrikes = Math.max(1, USER_FATIGUE_MAX_STRIKES || 1);

    let factor = 1;
    if (penaltyUntil > nowMs && strikes >= maxStrikes) {
      const base = Number.isFinite(USER_FATIGUE_PENALTY_FACTOR)
        ? USER_FATIGUE_PENALTY_FACTOR
        : 0.2;
      factor = clamp(base, 0, 1);
    }

    if (cache) {
      cache.set(userId, factor);
    }

    return factor;
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

    const userId = state.userId || (msg.sender_id != null ? String(msg.sender_id) : '');
    if (userId) {
      try {
        await this._updateUserFatigueOnUserMessage(userId, now);
      } catch (e) {
        logger.debug('DesireManager: update user fatigue on user message failed', {
          userId,
          err: String(e)
        });
      }
    }
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
    }

    state.lastUpdateAt = now;
    await this._saveState(conversationKey, state);

    if (proactive) {
      const userId = state.userId || (msg.sender_id != null ? String(msg.sender_id) : '');
      if (userId) {
        try {
          await this._updateUserFatigueOnProactive(userId, now);
        } catch (e) {
          logger.debug('DesireManager: update user fatigue on proactive failed', {
            userId,
            err: String(e)
          });
        }
      }
    }
  }

  async collectProactiveCandidates(now = Date.now()) {
    const result = [];
    const hourMs = 60 * 60 * 1000;

    // 在非活跃时间段内，直接禁止产生任何主动候选
    let activeStart = ACTIVE_HOUR_START;
    let activeEnd = ACTIVE_HOUR_END;
    if (!Number.isFinite(activeStart)) activeStart = 8;
    if (!Number.isFinite(activeEnd)) activeEnd = 23;

    const hourNow = new Date(now).getHours();
    let isActiveHour;
    if (activeStart === activeEnd) {
      isActiveHour = true;
    } else if (activeStart < activeEnd) {
      isActiveHour = hourNow >= activeStart && hourNow < activeEnd;
    } else {
      isActiveHour = hourNow >= activeStart || hourNow < activeEnd;
    }

    if (!isActiveHour) {
      return result;
    }

    // 计算每 tick 的基础触发概率，使一小时内期望最多发送 maxProactivePerHour 条
    const tickMs = getEnvInt('DESIRE_TICK_INTERVAL_MS', 60000);
    const safeTickMs = tickMs > 0 ? tickMs : 60000;
    const ticksPerHour = Math.max(1, Math.round(hourMs / safeTickMs));
    const rawBaseProbPerTick = this.maxProactivePerHour > 0
      ? this.maxProactivePerHour / ticksPerHour
      : 0;

    const intensity = Number.isFinite(PROACTIVE_INTENSITY) && PROACTIVE_INTENSITY > 0
      ? PROACTIVE_INTENSITY
      : 1;

    const baseProbPerTick = rawBaseProbPerTick * intensity;

    if (baseProbPerTick <= 0) {
      return result;
    }

    const userFatigueCache = new Map();

    for (const [conversationKey, stateRaw] of this.localCache.entries()) {
      const state = { ...getBaseState(), ...(stateRaw || {}) };

      const chatType = state.chatType || 'group';
      const lastUserAt = state.lastUserAt || 0;
      const lastBotAt = state.lastBotAt || 0;
      const lastProactiveAt = state.lastProactiveAt || 0;

      const sinceUserMs = lastUserAt ? now - lastUserAt : Infinity;
      const sinceBotMs = lastBotAt ? now - lastBotAt : Infinity;
      const sinceProactiveMs = lastProactiveAt ? now - lastProactiveAt : Infinity;

      const sinceUserSec = Number.isFinite(sinceUserMs) ? sinceUserMs / 1000 : Infinity;
      const sinceBotSec = Number.isFinite(sinceBotMs) ? sinceBotMs / 1000 : Infinity;
      const sinceProactiveSec = Number.isFinite(sinceProactiveMs) ? sinceProactiveMs / 1000 : Infinity;

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
      if (withinHour && this.maxProactivePerHour > 0 && proactiveCount >= this.maxProactivePerHour) {
        continue;
      }

      const maxMsg = chatType === 'group'
        ? this.groupMaxMsgPerWindow || GROUP_MAX_MSG_PER_WINDOW
        : this.privateMaxMsgPerWindow || PRIVATE_MAX_MSG_PER_WINDOW;

      if (maxMsg > 0 && msgCount > maxMsg) {
        // 频率过高，不主动插话
        continue;
      }

      if (!state.lastMsg) {
        continue;
      }

      // --- 概率模型：基于空闲时间 / 频率 / 配额的时间衰减触发 ---

      // 用户与机器人平均空闲时间（秒）
      const idleSec = Number.isFinite(sinceUserSec) && Number.isFinite(sinceBotSec)
        ? (sinceUserSec + sinceBotSec) / 2
        : (Number.isFinite(sinceUserSec) ? sinceUserSec : sinceBotSec);

      const minUserSec = chatType === 'group'
        ? GROUP_MIN_SINCE_USER_SEC
        : PRIVATE_MIN_SINCE_USER_SEC;
      const baseSilentSec = chatType === 'group'
        ? (this.groupSilentSec || GROUP_SILENT_SEC)
        : (this.privateSilentSec || PRIVATE_SILENT_SEC);
      const idleScale = Math.max(60, (minUserSec + baseSilentSec) / 2 || 300); // 约在该尺度附近达到 ~63% 饱和
      const idleFactor = idleSec > 0 && Number.isFinite(idleSec)
        ? 1 - Math.exp(-idleSec / idleScale)
        : 0;

      // 最近主动冷却：10 分钟内快速从 0→1
      let coolFactor = 1;
      if (Number.isFinite(sinceProactiveSec) && sinceProactiveSec >= 0 && sinceProactiveSec < 600) {
        coolFactor = sinceProactiveSec / 600;
      }

      // 消息频率因子：无互动 / 过度刷屏时削弱概率
      let trafficFactor = 1;
      if (!msgCount) {
        trafficFactor = 0;
      } else if (maxMsg > 0 && msgCount > maxMsg) {
        trafficFactor = 0;
      } else if (maxMsg > 0 && msgCount > maxMsg / 2) {
        trafficFactor = 0.5;
      }

      // 配额因子：接近当小时上限时指数下降
      let quotaFactor = 1;
      if (this.maxProactivePerHour > 0) {
        const usedRatio = proactiveCount / this.maxProactivePerHour;
        const exp = 1.5;
        quotaFactor = usedRatio >= 1 ? 0 : Math.pow(1 - clamp(usedRatio, 0, 1), exp);
      }

      const userIdForFatigue = state.userId
        || (state.lastMsg && state.lastMsg.sender_id != null
          ? String(state.lastMsg.sender_id)
          : '');
      const fatigueFactor = await this._getUserFatigueFactor(
        userIdForFatigue,
        now,
        userFatigueCache
      );

      let p = baseProbPerTick
        * idleFactor
        * coolFactor
        * trafficFactor
        * quotaFactor
        * fatigueFactor;

      if (!Number.isFinite(p) || p <= 0) {
        continue;
      }

      p = clamp(p, 0, 0.9);

      if (Math.random() >= p) {
        continue;
      }

      // 标记本次是否为「自上次用户消息以来的第一次主动回合」
      const isFirstAfterUser =
        lastUserAt > 0 && (!lastProactiveAt || lastUserAt >= lastProactiveAt);

      this.localCache.set(conversationKey, state);

      logger.debug('DesireManager: proactive candidate selected', {
        conversationKey,
        chatType,
        msgCount,
        idleSec,
        sinceUserSec,
        sinceBotSec,
        sinceProactiveSec,
        proactiveCount,
        userId: userIdForFatigue,
        fatigueFactor,
        prob: Number(p.toFixed(4)),
        isFirstAfterUser
      });

      result.push({
        conversationKey,
        chatType,
        groupId: state.groupId,
        userId: state.userId,
        lastMsg: state.lastMsg,
        desireScore: Math.round(p * 100),
        isFirstAfterUser
      });
    }

    return result;
  }
}
