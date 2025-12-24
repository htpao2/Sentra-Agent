import { getRedis, isRedisReady } from './redisClient.js';
import { getEnv, getEnvInt, getEnvBool, onEnvReload } from './envHotReloader.js';
import { createLogger } from './logger.js';

const logger = createLogger('DesireManager');

function getDesireRuntimeDefaults() {
  return {
    enabled: getEnvBool('DESIRE_ENABLED', true),
    prefix: getEnv('REDIS_DESIRE_PREFIX', 'sentra:desire:'),
    desireTtlSeconds: getEnvInt('DESIRE_TTL_SECONDS', 86400),
    groupSilentSec: getEnvInt('DESIRE_GROUP_SILENT_SEC', 180),
    privateSilentSec: getEnvInt('DESIRE_PRIVATE_SILENT_SEC', 120),
    groupMinSinceUserSec: getEnvInt('DESIRE_GROUP_MIN_SINCE_USER_SEC', 60),
    privateMinSinceUserSec: getEnvInt('DESIRE_PRIVATE_MIN_SINCE_USER_SEC', 30),
    maxProactivePerHour: getEnvInt('DESIRE_MAX_PROACTIVE_PER_HOUR', 3),
    maxProactivePerDay: getEnvInt('DESIRE_MAX_PROACTIVE_PER_DAY', 0),
    msgWindowSec: getEnvInt('DESIRE_MSG_WINDOW_SEC', 120),
    groupMaxMsgPerWindow: getEnvInt('DESIRE_GROUP_MAX_MSG_PER_WINDOW', 8),
    privateMaxMsgPerWindow: getEnvInt('DESIRE_PRIVATE_MAX_MSG_PER_WINDOW', 12),
    activeHourStart: getEnvInt('DESIRE_ACTIVE_HOUR_START', 8),
    activeHourEnd: getEnvInt('DESIRE_ACTIVE_HOUR_END', 23),
    proactiveIntensity: Number.parseFloat(getEnv('DESIRE_PROACTIVE_INTENSITY', '1')),
    minIntervalBetweenProactiveSec: getEnvInt('DESIRE_MIN_INTERVAL_BETWEEN_PROACTIVE_SEC', 300),
    userFatigueEnabled: getEnvBool('DESIRE_USER_FATIGUE_ENABLED', true),
    userFatigueResponseWindowSec: getEnvInt('DESIRE_USER_FATIGUE_RESPONSE_WINDOW_SEC', 300),
    userFatigueMaxStrikes: getEnvInt('DESIRE_USER_FATIGUE_MAX_STRIKES', 3),
    userFatiguePenaltyFactor: Number.parseFloat(getEnv('DESIRE_USER_FATIGUE_PENALTY_FACTOR', '0.2')),
    userFatiguePenaltyDurationSec: getEnvInt('DESIRE_USER_FATIGUE_PENALTY_DURATION_SEC', 3600),
    userFatigueTtlSeconds: getEnvInt('DESIRE_USER_FATIGUE_TTL_SECONDS', 86400),
    userFatiguePrefix: getEnv('REDIS_DESIRE_USER_FATIGUE_PREFIX', 'sentra:desire:user:')
  };
}

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
    dailyProactiveDay: 0,
    dailyProactiveCount: 0,
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
    this.options = options && typeof options === 'object' ? options : {};
    this._applyConfig(getDesireRuntimeDefaults());

    onEnvReload(() => {
      this._applyConfig(getDesireRuntimeDefaults());
    });

    this.localCache = new Map(); // Map<conversationKey, state>
  }

  _applyConfig(defaults) {
    const d = defaults || {};
    const o = this.options || {};

    this.enabled = typeof o.enabled === 'boolean' ? o.enabled : d.enabled;
    this.prefix = typeof o.prefix === 'string' && o.prefix ? o.prefix : (d.prefix || 'sentra:desire:');
    this.desireTtlSeconds = Number.isFinite(o.desireTtlSeconds) ? o.desireTtlSeconds : d.desireTtlSeconds;

    this.groupSilentSec = Number.isFinite(o.groupSilentSec) ? o.groupSilentSec : d.groupSilentSec;
    this.privateSilentSec = Number.isFinite(o.privateSilentSec) ? o.privateSilentSec : d.privateSilentSec;
    this.groupMinSinceUserSec = Number.isFinite(o.groupMinSinceUserSec) ? o.groupMinSinceUserSec : d.groupMinSinceUserSec;
    this.privateMinSinceUserSec = Number.isFinite(o.privateMinSinceUserSec) ? o.privateMinSinceUserSec : d.privateMinSinceUserSec;

    this.maxProactivePerHour = Number.isFinite(o.maxProactivePerHour) ? o.maxProactivePerHour : d.maxProactivePerHour;
    this.maxProactivePerDay = Number.isFinite(o.maxProactivePerDay) ? o.maxProactivePerDay : d.maxProactivePerDay;

    this.msgWindowSec = Number.isFinite(o.msgWindowSec) ? o.msgWindowSec : d.msgWindowSec;
    this.groupMaxMsgPerWindow = Number.isFinite(o.groupMaxMsgPerWindow) ? o.groupMaxMsgPerWindow : d.groupMaxMsgPerWindow;
    this.privateMaxMsgPerWindow = Number.isFinite(o.privateMaxMsgPerWindow) ? o.privateMaxMsgPerWindow : d.privateMaxMsgPerWindow;

    this.activeHourStart = Number.isFinite(o.activeHourStart) ? o.activeHourStart : d.activeHourStart;
    this.activeHourEnd = Number.isFinite(o.activeHourEnd) ? o.activeHourEnd : d.activeHourEnd;

    this.proactiveIntensity = Number.isFinite(o.proactiveIntensity) ? o.proactiveIntensity : d.proactiveIntensity;
    this.minIntervalBetweenProactiveSec = Number.isFinite(o.minIntervalBetweenProactiveSec)
      ? o.minIntervalBetweenProactiveSec
      : d.minIntervalBetweenProactiveSec;

    this.userFatigueEnabled = typeof o.userFatigueEnabled === 'boolean' ? o.userFatigueEnabled : d.userFatigueEnabled;
    this.userFatigueResponseWindowSec = Number.isFinite(o.userFatigueResponseWindowSec)
      ? o.userFatigueResponseWindowSec
      : d.userFatigueResponseWindowSec;
    this.userFatigueMaxStrikes = Number.isFinite(o.userFatigueMaxStrikes) ? o.userFatigueMaxStrikes : d.userFatigueMaxStrikes;
    this.userFatiguePenaltyFactor = Number.isFinite(o.userFatiguePenaltyFactor) ? o.userFatiguePenaltyFactor : d.userFatiguePenaltyFactor;
    this.userFatiguePenaltyDurationSec = Number.isFinite(o.userFatiguePenaltyDurationSec)
      ? o.userFatiguePenaltyDurationSec
      : d.userFatiguePenaltyDurationSec;
    this.userFatigueTtlSeconds = Number.isFinite(o.userFatigueTtlSeconds) ? o.userFatigueTtlSeconds : d.userFatigueTtlSeconds;
    this.userFatiguePrefix = typeof o.userFatiguePrefix === 'string' && o.userFatiguePrefix
      ? o.userFatiguePrefix
      : (d.userFatiguePrefix || 'sentra:desire:user:');
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
      if (Number.isFinite(this.desireTtlSeconds) && this.desireTtlSeconds > 0) {
        await redis.set(key, payload, 'EX', this.desireTtlSeconds);
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
    return `${this.userFatiguePrefix}${userId}`;
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
      const ttl = Number.isFinite(this.userFatigueTtlSeconds) && this.userFatigueTtlSeconds > 0
        ? this.userFatigueTtlSeconds
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
    if (!this.userFatigueEnabled || !userId) return;

    const windowSec = Math.max(0, this.userFatigueResponseWindowSec || 0);
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
    if (!this.userFatigueEnabled || !userId) return;

    const windowSec = Math.max(0, this.userFatigueResponseWindowSec || 0);
    const windowMs = windowSec * 1000;
    const nowMs = now;
    const maxStrikes = Math.max(1, this.userFatigueMaxStrikes || 1);

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
      const penaltyDurationSec = Math.max(0, this.userFatiguePenaltyDurationSec || 0);
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
    if (!this.userFatigueEnabled || !userId) {
      return 1;
    }

    if (cache && cache.has(userId)) {
      return cache.get(userId);
    }

    const state = await this._loadUserFatigue(userId);
    const nowMs = now;
    const penaltyUntil = Number.isFinite(state.penaltyUntil) ? state.penaltyUntil : 0;
    const strikes = Number.isFinite(state.strikes) ? state.strikes : 0;
    const maxStrikes = Math.max(1, this.userFatigueMaxStrikes || 1);

    let factor = 1;
    if (penaltyUntil > nowMs && strikes >= maxStrikes) {
      const base = Number.isFinite(this.userFatiguePenaltyFactor)
        ? this.userFatiguePenaltyFactor
        : 0.2;
      factor = clamp(base, 0, 1);
    }

    if (cache) {
      cache.set(userId, factor);
    }

    return factor;
  }

  async onUserMessage(msg) {
    if (!this.enabled) return;
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
      const windowMs = (this.msgWindowSec || 120) * 1000;
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
    if (!this.enabled) return;
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

      // 每日主动次数统计（基于固定 24 小时窗口）
      const dayMs = 24 * 60 * 60 * 1000;
      const todayKey = Math.floor(now / dayMs);
      const storedDay = Number.isFinite(state.dailyProactiveDay) ? state.dailyProactiveDay : 0;
      if (!storedDay || storedDay !== todayKey) {
        state.dailyProactiveDay = todayKey;
        state.dailyProactiveCount = 1;
      } else {
        state.dailyProactiveCount = (state.dailyProactiveCount || 0) + 1;
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

  async getUserEngagementSummary(conversationKey, userId, now = Date.now()) {
    if (!this.enabled) return null;
    const nowMs = now;

    let state = null;
    if (conversationKey) {
      try {
        state = await this._loadState(conversationKey);
      } catch (e) {
        logger.debug('DesireManager: getUserEngagementSummary _loadState failed', {
          conversationKey,
          err: String(e)
        });
      }
    }
    if (!state) {
      state = getBaseState();
    }

    const safeTs = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
    const safeDiffSec = (ts) => {
      const t = safeTs(ts);
      if (!t) return null;
      const d = nowMs - t;
      if (!Number.isFinite(d) || d < 0) return null;
      return d / 1000;
    };

    const lastUserAt = safeTs(state.lastUserAt);
    const lastBotAt = safeTs(state.lastBotAt);
    const lastProactiveAt = safeTs(state.lastProactiveAt);

    const timeSinceLastUserSec = safeDiffSec(lastUserAt);
    const timeSinceLastBotSec = safeDiffSec(lastBotAt);
    const timeSinceLastProactiveSec = safeDiffSec(lastProactiveAt);

    const uid = userId
      || state.userId
      || (state.lastMsg && state.lastMsg.sender_id != null
        ? String(state.lastMsg.sender_id)
        : '');

    let strikes = 0;
    let lastUserReplyAt = 0;
    let fatigueLastProactiveAt = 0;
    let penaltyUntil = 0;
    let penaltyActive = false;
    let timeSinceLastUserReplySec = null;

    if (uid) {
      try {
        const uf = await this._loadUserFatigue(uid);
        strikes = Number.isFinite(uf.strikes) ? uf.strikes : 0;
        lastUserReplyAt = safeTs(uf.lastUserReplyAt);
        fatigueLastProactiveAt = safeTs(uf.lastProactiveAt);
        penaltyUntil = Number.isFinite(uf.penaltyUntil) ? uf.penaltyUntil : 0;
        timeSinceLastUserReplySec = safeDiffSec(lastUserReplyAt);
        penaltyActive = penaltyUntil > nowMs;
      } catch (e) {
        logger.debug('DesireManager: getUserEngagementSummary _loadUserFatigue failed', {
          userId: uid,
          err: String(e)
        });
      }
    }

    const repliedSinceLastProactive =
      fatigueLastProactiveAt > 0
      && lastUserReplyAt >= fatigueLastProactiveAt
      && lastUserReplyAt <= nowMs;

    return {
      conversationKey: conversationKey || null,
      userId: uid || null,
      lastUserAt,
      lastBotAt,
      lastProactiveAt,
      timeSinceLastUserSec,
      timeSinceLastBotSec,
      timeSinceLastProactiveSec,
      lastUserReplyAt,
      timeSinceLastUserReplySec,
      ignoredProactiveStrikes: strikes,
      penaltyUntil,
      penaltyActive,
      repliedSinceLastProactive
    };
  }

  async collectProactiveCandidates(now = Date.now()) {
    if (!this.enabled) return [];
    const result = [];
    const hourMs = 60 * 60 * 1000;

    // 在非活跃时间段内，直接禁止产生任何主动候选
    let activeStart = this.activeHourStart;
    let activeEnd = this.activeHourEnd;
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

    const intensity = Number.isFinite(this.proactiveIntensity) && this.proactiveIntensity > 0
      ? this.proactiveIntensity
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

      const minIntervalSec = this.minIntervalBetweenProactiveSec;
      if (
        minIntervalSec > 0 &&
        Number.isFinite(sinceProactiveSec) &&
        sinceProactiveSec >= 0 &&
        sinceProactiveSec < minIntervalSec
      ) {
        logger.debug('DesireManager: skip proactive due to per-conversation min interval', {
          conversationKey,
          chatType,
          sinceProactiveSec,
          minIntervalSec
        });
        continue;
      }

      // 频率窗口
      const windowMs = (this.msgWindowSec || 120) * 1000;
      let msgCount = state.msgCount || 0;
      if (state.msgWindowStart && now - state.msgWindowStart > windowMs) {
        msgCount = 0;
      }

      // 每小时主动次数限制
      const windowStart = state.proactiveWindowStart || 0;
      const withinHour = windowStart && now - windowStart < hourMs;
      const proactiveCount = state.proactiveCount || 0;
      if (withinHour && this.maxProactivePerHour > 0 && proactiveCount >= this.maxProactivePerHour) {
        logger.debug('DesireManager: skip proactive due to hourly cap', {
          conversationKey,
          chatType,
          proactiveCount,
          maxPerHour: this.maxProactivePerHour
        });
        continue;
      }

      // 每日主动次数限制（基于固定 24 小时窗口）
      const dayMs = 24 * 60 * 60 * 1000;
      let dailyCount = 0;
      const storedDayRaw = state.dailyProactiveDay;
      if (Number.isFinite(storedDayRaw)) {
        const todayKey = Math.floor(now / dayMs);
        if (storedDayRaw === todayKey) {
          dailyCount = state.dailyProactiveCount || 0;
        }
      }

      if (this.maxProactivePerDay > 0 && dailyCount >= this.maxProactivePerDay) {
        logger.debug('DesireManager: skip proactive due to daily cap', {
          conversationKey,
          chatType,
          dailyCount,
          maxPerDay: this.maxProactivePerDay
        });
        continue;
      }

      const maxMsg = chatType === 'group'
        ? (this.groupMaxMsgPerWindow || 8)
        : (this.privateMaxMsgPerWindow || 12);

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
        ? (this.groupMinSinceUserSec || 60)
        : (this.privateMinSinceUserSec || 30);
      const baseSilentSec = chatType === 'group'
        ? (this.groupSilentSec || 180)
        : (this.privateSilentSec || 120);
      const idleScale = Math.max(60, (minUserSec + baseSilentSec) / 2 || 300); // 约在该尺度附近达到 ~63% 饱和
      const idleFactor = idleSec > 0 && Number.isFinite(idleSec)
        ? 1 - Math.exp(-idleSec / idleScale)
        : 0;

      // 最近主动冷却：10 分钟内快速从 0→1
      let coolFactor = 1;
      if (Number.isFinite(sinceProactiveSec) && sinceProactiveSec >= 0 && sinceProactiveSec < 600) {
        coolFactor = sinceProactiveSec / 600;
      }

      // 消息频率因子：主要针对刷屏场景退避，不阻断长时间无消息的会话
      let trafficFactor = 1;
      if (maxMsg > 0 && msgCount > maxMsg) {
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
        dailyProactiveCount: dailyCount,
        userId: userIdForFatigue,
        fatigueFactor,
        idleFactor,
        coolFactor,
        trafficFactor,
        quotaFactor,
        maxProactivePerHour: this.maxProactivePerHour,
        maxProactivePerDay: this.maxProactivePerDay,
        baseProbPerTick: Number(baseProbPerTick.toFixed(4)),
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
