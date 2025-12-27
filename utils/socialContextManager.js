import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';
import { getEnvBool, getEnvInt } from './envHotReloader.js';

const logger = createLogger('SocialContextManager');

function safeInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeIdString(v) {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s : '';
}

function escapeXmlText(v) {
  const s = String(v ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildSocialContextXml(payload) {
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  const friends = Array.isArray(payload?.friends) ? payload.friends : [];

  const groupCount = groups.length;
  const friendCount = friends.length;

  const lines = [];
  lines.push('<sentra-social-context>');
  lines.push(`  <groups count="${groupCount}">`);
  for (const g of groups) {
    const gid = normalizeIdString(g?.group_id);
    if (!gid) continue;
    const name = String(g?.group_name ?? '').trim();
    lines.push('    <group>');
    lines.push(`      <id>${gid}</id>`);
    if (name) lines.push(`      <name>${escapeXmlText(name)}</name>`);
    lines.push('    </group>');
  }
  lines.push('  </groups>');

  lines.push(`  <friends count="${friendCount}">`);
  for (const f of friends) {
    const uid = normalizeIdString(f?.user_id);
    if (!uid) continue;
    const nick = String(f?.nickname ?? '').trim();
    lines.push('    <friend>');
    lines.push(`      <id>${uid}</id>`);
    if (nick) lines.push(`      <name>${escapeXmlText(nick)}</name>`);
    lines.push('    </friend>');
  }
  lines.push('  </friends>');

  lines.push('</sentra-social-context>');
  return lines.join('\n');
}

export class SocialContextManager {
  constructor(options = {}) {
    this.sendAndWaitResult = options.sendAndWaitResult;
    this.cacheDir = options.cacheDir || path.resolve(process.cwd(), 'cache', 'social');
    this.cachePath = path.join(this.cacheDir, 'social_context.json');
    this.cached = null;
    this.refreshing = null;
  }

  isEnabled() {
    return getEnvBool('SOCIAL_CONTEXT_ENABLED', true);
  }

  getTtlMs() {
    const raw = getEnvInt('SOCIAL_CONTEXT_TTL_MS', 30 * 60 * 1000);
    return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
  }

  getMaxGroups() {
    const raw = getEnvInt('SOCIAL_CONTEXT_MAX_GROUPS', 200);
    return Number.isFinite(raw) && raw > 0 ? raw : 200;
  }

  getMaxFriends() {
    const raw = getEnvInt('SOCIAL_CONTEXT_MAX_FRIENDS', 200);
    return Number.isFinite(raw) && raw > 0 ? raw : 200;
  }

  async _ensureDir() {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch {}
  }

  async _loadFromDisk() {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf-8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      if (typeof data.cachedAt !== 'number') return null;
      if (typeof data.xml !== 'string') return null;
      return data;
    } catch {
      return null;
    }
  }

  async _saveToDisk(data) {
    try {
      await this._ensureDir();
      await fs.writeFile(this.cachePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      logger.debug('save cache failed', { err: String(e) });
    }
  }

  _isFresh(data, now = Date.now()) {
    if (!data || typeof data.cachedAt !== 'number') return false;
    const ttlMs = this.getTtlMs();
    return now - data.cachedAt <= ttlMs;
  }

  async _callSdk(pathStr, args = []) {
    if (typeof this.sendAndWaitResult !== 'function') {
      throw new Error('missing_sendAndWaitResult');
    }
    const payload = {
      type: 'sdk',
      path: pathStr,
      args: Array.isArray(args) ? args : []
    };
    const res = await this.sendAndWaitResult(payload);
    if (!res || res.ok !== true) {
      throw new Error('napcat_sdk_call_failed');
    }
    return res.data;
  }

  _extractOneBotData(resp) {
    if (!resp) return null;
    if (Array.isArray(resp)) return resp;
    if (resp && Array.isArray(resp.data)) return resp.data;
    return null;
  }

  async refresh(force = false) {
    if (!this.isEnabled()) {
      this.cached = null;
      return null;
    }

    const now = Date.now();
    if (!force) {
      if (this.cached && this._isFresh(this.cached, now)) return this.cached;
      const disk = await this._loadFromDisk();
      if (disk && this._isFresh(disk, now)) {
        this.cached = disk;
        return disk;
      }
    }

    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      const ttlMs = this.getTtlMs();
      const maxGroups = this.getMaxGroups();
      const maxFriends = this.getMaxFriends();

      let self = {};
      let groups = [];
      let friends = [];

      try {
        const gl = await this._callSdk('group.list', []);
        const arr = this._extractOneBotData(gl);
        if (Array.isArray(arr)) {
          groups = arr
            .map((g) => ({ group_id: g?.group_id, group_name: g?.group_name }))
            .filter((g) => normalizeIdString(g?.group_id))
            .slice(0, maxGroups);
        }
      } catch {}

      try {
        const fl = await this._callSdk('user.friendList', []);
        const arr = this._extractOneBotData(fl);
        if (Array.isArray(arr)) {
          friends = arr
            .map((f) => ({ user_id: f?.user_id, nickname: f?.nickname }))
            .filter((f) => normalizeIdString(f?.user_id))
            .slice(0, maxFriends);
        }
      } catch {}

      const xml = buildSocialContextXml({
        groups,
        friends
      });

      const out = {
        cachedAt: Date.now(),
        ttlMs,
        groups,
        friends,
        xml
      };

      this.cached = out;
      await this._saveToDisk(out);
      return out;
    })().finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }

  async getXml() {
    if (!this.isEnabled()) return '';
    try {
      const data = await this.refresh(false);
      return data && typeof data.xml === 'string' ? data.xml : '';
    } catch {
      return '';
    }
  }
}
