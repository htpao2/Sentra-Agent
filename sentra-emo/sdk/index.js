const envHost = process.env.APP_HOST || '127.0.0.1';
const envPort = (() => {
  const p = process.env.APP_PORT;
  const n = p && Number(p);
  return Number.isFinite(n) && n > 0 ? String(n) : '7200';
})();
const DEFAULT_BASE_URL = `http://${envHost}:${envPort}`;

function joinURL(base, path) {
  if (!base) return path;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function toISO(val) {
  if (val == null) return undefined;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'number' && Number.isFinite(val)) {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof val === 'string') {
    // Try to parse; if fails, send raw string (assume already ISO)
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return val;
  }
  return String(val);
}

async function requestJSON(baseURL, path, { method = 'GET', body, signal, timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeout);
  try {
    const res = await fetch(joinURL(baseURL, path), {
      method,
      headers: {
        'content-type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal || ctrl.signal
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export default class SentraEmo {
  constructor(options = {}) {
    this.baseURL = options.baseURL || DEFAULT_BASE_URL;
    this.timeout = typeof options.timeout === 'number' ? options.timeout : 30000;
  }

  async health(opts = {}) {
    return requestJSON(this.baseURL, '/health', { method: 'GET', timeout: opts.timeout ?? this.timeout, signal: opts.signal });
  }

  async models(opts = {}) {
    return requestJSON(this.baseURL, '/models', { method: 'GET', timeout: opts.timeout ?? this.timeout, signal: opts.signal });
  }

  async metrics(opts = {}) {
    return requestJSON(this.baseURL, '/metrics', { method: 'GET', timeout: opts.timeout ?? this.timeout, signal: opts.signal });
  }

  async analyze(text, opts = {}) {
    const payload = typeof text === 'string' ? { text, userid: opts.userid, username: opts.username } : text;
    if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) {
      throw new Error('text is required');
    }
    const body = { text: payload.text };
    if (payload.userid) body.userid = payload.userid;
    if (payload.username) body.username = payload.username;
    return requestJSON(this.baseURL, '/analyze', { method: 'POST', body, timeout: opts.timeout ?? this.timeout, signal: opts.signal });
  }

  async analyzeBatch(texts, opts = {}) {
    const list = Array.isArray(texts) ? texts.filter(t => typeof t === 'string' && t.trim().length > 0) : [];
    if (!list.length) throw new Error('texts must be a non-empty array of strings');
    try {
      const body = { texts: list };
      if (opts.userid) body.userid = opts.userid;
      if (opts.username) body.username = opts.username;
      return await requestJSON(this.baseURL, '/analyze/batch', { method: 'POST', body, timeout: opts.timeout ?? this.timeout, signal: opts.signal });
    } catch (err) {
      if (err && (err.status === 404 || err.status === 405)) {
        // fallback to client-side concurrent batching
        return await this.batchAnalyze(list, opts);
      }
      throw err;
    }
  }

  async batchAnalyze(texts, opts = {}) {
    const list = Array.isArray(texts) ? texts : [];
    const concurrency = typeof opts.concurrency === 'number' && opts.concurrency > 0 ? Math.floor(opts.concurrency) : 4;
    const results = new Array(list.length);
    let inFlight = 0;
    let idx = 0;
    const next = () => {
      if (idx >= list.length) return Promise.resolve();
      const cur = idx++;
      inFlight++;
      const t = list[cur];
      return this.analyze(typeof t === 'string' ? { text: t, userid: opts.userid, username: opts.username } : t, opts)
        .then((r) => {
          results[cur] = r;
          if (typeof opts.onProgress === 'function') opts.onProgress({ index: cur, total: list.length });
        })
        .catch((e) => {
          results[cur] = { error: e && e.message ? e.message : String(e) };
        })
        .finally(() => {
          inFlight--;
        })
        .then(() => next());
    };
    const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => next());
    await Promise.all(workers);
    return results;
  }

  async userState(userid, opts = {}) {
    if (!userid || typeof userid !== 'string') throw new Error('userid is required');
    return requestJSON(this.baseURL, `/user/${encodeURIComponent(userid)}`, { method: 'GET', timeout: opts.timeout ?? this.timeout, signal: opts.signal });
  }

  async userEvents(userid, opts = {}) {
    if (!userid || typeof userid !== 'string') throw new Error('userid is required');
    const limit = typeof opts.limit === 'number' ? opts.limit : 200;
    const qp = new URLSearchParams();
    qp.set('limit', String(limit));
    const s = toISO(opts.start);
    const e = toISO(opts.end);
    if (s) qp.set('start', s);
    if (e) qp.set('end', e);
    const path = `/user/${encodeURIComponent(userid)}/events?${qp.toString()}`;
    return requestJSON(this.baseURL, path, { method: 'GET', timeout: opts.timeout ?? this.timeout, signal: opts.signal });
  }

  async userAnalytics(userid, opts = {}) {
    if (!userid || typeof userid !== 'string') throw new Error('userid is required');
    const qp = new URLSearchParams();
    if (typeof opts.days === 'number') qp.set('days', String(opts.days));
    const s = toISO(opts.start);
    const e = toISO(opts.end);
    if (s) qp.set('start', s);
    if (e) qp.set('end', e);
    const path = `/user/${encodeURIComponent(userid)}/analytics?${qp.toString()}`;
    return requestJSON(this.baseURL, path, { method: 'GET', timeout: opts.timeout ?? this.timeout, signal: opts.signal });
  }

  async userExport(userid, opts = {}) {
    if (!userid || typeof userid !== 'string') throw new Error('userid is required');
    return requestJSON(this.baseURL, `/user/${encodeURIComponent(userid)}/export`, { method: 'POST', timeout: opts.timeout ?? this.timeout, signal: opts.signal });
  }
}
