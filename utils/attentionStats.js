import { createLogger } from './logger.js';
import { getRedis, isRedisReady } from './redisClient.js';
import { getEnvInt } from './envHotReloader.js';

const logger = createLogger('AttentionStats');
const localCache = new Map();

function makeKey(groupId, senderId) {
  const g = groupId != null ? String(groupId) : '';
  const s = senderId != null ? String(senderId) : '';
  return `att_stats:${g}:${s}`;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function getTtlSec() {
  const raw = getEnvInt('ATTENTION_STATS_TTL_SEC', 600);
  if (!Number.isFinite(raw) || raw <= 0) return 600;
  return raw;
}

function getBaseStats() {
  return {
    windowStart: 0,
    lastUpdate: 0,
    consideredCount: 0,
    repliedCount: 0,
    sumAnalyzerProb: 0,
    sumGateProb: 0,
    sumFusedProb: 0
  };
}

export async function loadAttentionStats(groupId, senderId) {
  const key = makeKey(groupId, senderId);
  const base = getBaseStats();
  const redis = getRedis();
  if (!redis || !isRedisReady()) {
    const cached = localCache.get(key);
    return cached ? { ...base, ...cached } : base;
  }
  try {
    const raw = await redis.get(key);
    if (!raw) {
      const cached = localCache.get(key);
      return cached ? { ...base, ...cached } : base;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return base;
    return { ...base, ...parsed };
  } catch (e) {
    logger.error('loadAttentionStats failed', { key, err: String(e) });
    const cached = localCache.get(key);
    return cached ? { ...base, ...cached } : base;
  }
}

export async function updateAttentionStatsAfterDecision(payload) {
  if (!payload) return;
  const groupId = payload.groupId;
  const senderId = payload.senderId;
  if (groupId == null || senderId == null) return;
  const key = makeKey(groupId, senderId);
  const now = Date.now();
  let stats = await loadAttentionStats(groupId, senderId);
  if (!stats || typeof stats !== 'object') {
    stats = getBaseStats();
  }
  if (!stats.windowStart || !Number.isFinite(stats.windowStart)) {
    stats.windowStart = now;
  }
  stats.lastUpdate = now;
  stats.consideredCount = (stats.consideredCount || 0) + 1;
  if (typeof payload.analyzerProb === 'number' && Number.isFinite(payload.analyzerProb)) {
    stats.sumAnalyzerProb = (stats.sumAnalyzerProb || 0) + clamp01(payload.analyzerProb);
  }
  if (typeof payload.gateProb === 'number' && Number.isFinite(payload.gateProb)) {
    stats.sumGateProb = (stats.sumGateProb || 0) + clamp01(payload.gateProb);
  }
  if (typeof payload.fusedProb === 'number' && Number.isFinite(payload.fusedProb)) {
    stats.sumFusedProb = (stats.sumFusedProb || 0) + clamp01(payload.fusedProb);
  }
  if (payload.didReply) {
    stats.repliedCount = (stats.repliedCount || 0) + 1;
  }
  localCache.set(key, stats);
  const redis = getRedis();
  if (!redis || !isRedisReady()) return;
  try {
    const ttl = getTtlSec();
    await redis.set(key, JSON.stringify(stats), 'EX', ttl);
  } catch (e) {
    logger.error('updateAttentionStatsAfterDecision failed', { key, err: String(e) });
  }
}
