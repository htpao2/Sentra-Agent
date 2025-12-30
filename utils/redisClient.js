import Redis from 'ioredis';
import { createLogger } from './logger.js';
import { getEnv, getEnvInt } from './envHotReloader.js';

const logger = createLogger('RedisClient');

let redisInstance = null;

function getRedisConfig() {
  const host = getEnv('REDIS_HOST', '127.0.0.1');
  const port = getEnvInt('REDIS_PORT', 6379);
  const db = getEnvInt('REDIS_DB', 0);
  const password = getEnv('REDIS_PASSWORD', undefined) || undefined;
  const enabled = getEnv('REDIS_ENABLED', undefined);

  // 显式关闭：REDIS_ENABLED=false
  if (enabled === 'false') {
    return null;
  }

  return { host, port, db, password };
}

export function getRedis() {
  const cfg = getRedisConfig();
  if (!cfg) {
    return null;
  }

  if (!redisInstance) {
    redisInstance = new Redis({
      host: cfg.host,
      port: cfg.port,
      db: cfg.db,
      password: cfg.password,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    });

    redisInstance.on('error', (err) => {
      logger.error('Redis error', { label: 'REDIS', err: String(err) });
    });

    redisInstance.on('connect', () => {
      logger.info('Redis connected', {
        label: 'REDIS',
        host: cfg.host,
        port: cfg.port,
        db: cfg.db,
      });
    });

    logger.info('Redis connecting', {
      label: 'REDIS',
      host: cfg.host,
      port: cfg.port,
      db: cfg.db,
    });

    redisInstance.connect().catch((e) => {
      logger.error('Redis connect failed', { label: 'REDIS', e: String(e) });
    });
  }

  return redisInstance;
}

export function isRedisReady() {
  try {
    const r = getRedis();
    return !!r && r.status === 'ready';
  } catch {
    return false;
  }
}

export function getRedisSafe() {
  try {
    const r = getRedis();
    if (!r || !isRedisReady()) return null;
    return r;
  } catch {
    return null;
  }
}
