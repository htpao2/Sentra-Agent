import { createLogger } from './logger.js';
import { getEnvInt, getEnvBool } from './envHotReloader.js';

const logger = createLogger('MemoryMonitor');

function toMB(bytes) {
  if (!Number.isFinite(bytes)) return null;
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function safeCall(fn) {
  try {
    return fn();
  } catch (e) {
    return { _error: String(e) };
  }
}

export function startMemoryMonitor(providers = []) {
  const enabled = getEnvBool('MEMORY_MONITOR_ENABLED', true);
  if (!enabled) {
    return { stop: () => {} };
  }

  const intervalMs = getEnvInt('MEMORY_MONITOR_INTERVAL_MS', 60000);
  const ms = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000;

  const timer = setInterval(() => {
    const mu = process.memoryUsage();
    const base = {
      rss_mb: toMB(mu.rss),
      heap_total_mb: toMB(mu.heapTotal),
      heap_used_mb: toMB(mu.heapUsed),
      external_mb: toMB(mu.external),
      array_buffers_mb: toMB(mu.arrayBuffers)
    };

    const extra = {};
    for (const p of Array.isArray(providers) ? providers : []) {
      if (!p || typeof p !== 'object') continue;
      const name = p.name ? String(p.name) : 'unknown';
      const fn = p.getStats;
      if (typeof fn !== 'function') continue;
      extra[name] = safeCall(fn);
    }

    logger.info('memory', { ...base, providers: extra });
  }, ms);

  timer.unref?.();

  return {
    stop: () => {
      try { clearInterval(timer); } catch {}
    }
  };
}
