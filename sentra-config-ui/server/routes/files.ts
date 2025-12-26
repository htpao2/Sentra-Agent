import { FastifyInstance } from 'fastify';
import { join, resolve, relative, dirname } from 'path';
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, rmSync } from 'fs';

// Helper to get root directory
function getRootDir(): string {
    return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

// Helper to check if path is safe (inside root)
function isSafePath(targetPath: string): boolean {
    const rootDir = getRootDir();
    const resolvedPath = resolve(rootDir, targetPath);
    return resolvedPath.startsWith(rootDir);
}

// Helper to get absolute path
function getAbsolutePath(targetPath: string): string {
    return join(getRootDir(), targetPath);
}

const IGNORED_DIRS = ['node_modules', '.git', '.cache', 'dist', 'build', 'coverage', '.idea', '.vscode'];
const IGNORED_FILES = ['.DS_Store', 'Thumbs.db'];

type CacheEntry<T> = {
    expiresAt: number;
    etag: string;
    payload: T;
};

const TREE_CACHE_TTL_MS = clampInt(process.env.FILE_TREE_CACHE_TTL_MS, 0, 60_000, 6_000);
const SEARCH_CACHE_TTL_MS = clampInt(process.env.FILE_SEARCH_CACHE_TTL_MS, 0, 60_000, 4_000);

const treeCache = new Map<string, CacheEntry<any>>();
const treeInflight = new Map<string, Promise<{ payload: any; etag: string }>>();

const grepCache = new Map<string, CacheEntry<any>>();
const grepInflight = new Map<string, Promise<{ payload: any; etag: string }>>();

const symbolsCache = new Map<string, CacheEntry<any>>();
const symbolsInflight = new Map<string, Promise<{ payload: any; etag: string }>>();

function maybeTrimCache(map: Map<string, any>, maxSize: number) {
    if (map.size <= maxSize) return;
    map.clear();
}

function sendWithEtag(reply: any, etag: string) {
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
    reply.header('ETag', etag);
}

function isBinaryLikePath(p: string): boolean {
    return /\.(jpg|jpeg|png|gif|webp|svg|ico|bmp|tiff|mp4|mov|avi|mkv|zip|gz|tar|7z|rar|exe|dll|bin)$/i.test(p);
}

function shouldScanTextFile(p: string): boolean {
    if (isBinaryLikePath(p)) return false;
    if (/\.(lock|min\.js|min\.css)$/i.test(p)) return false;
    return true;
}

function clampInt(n: any, min: number, max: number, fallback: number) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(v)));
}

export async function fileRoutes(fastify: FastifyInstance) {
    // Get file tree
    fastify.get<{
        Querystring: { path?: string };
    }>('/api/files/tree', async (request, reply) => {
        try {
            const relPath = request.query.path || '';

            if (!isSafePath(relPath)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(relPath);

            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Path not found' });
            }

            const stat = statSync(fullPath);
            if (!stat.isDirectory()) {
                return reply.code(400).send({ error: 'Path is not a directory' });
            }

            const cacheKey = `tree:${relPath}`;
            const ifNoneMatch = String(request.headers['if-none-match'] || '');
            const now = Date.now();

            if (TREE_CACHE_TTL_MS > 0) {
                const cached = treeCache.get(cacheKey);
                if (cached && cached.expiresAt > now) {
                    sendWithEtag(reply, cached.etag);
                    if (ifNoneMatch && ifNoneMatch === cached.etag) {
                        return reply.code(304).send();
                    }
                    return cached.payload;
                }
            }

            const inflight = treeInflight.get(cacheKey);
            if (inflight) {
                const resolved = await inflight;
                sendWithEtag(reply, resolved.etag);
                if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                    return reply.code(304).send();
                }
                return resolved.payload;
            }

            // Recursive scan function
            const job = (async () => {
                const results: any[] = [];

                const scanDir = (dir: string, baseDir: string) => {
                    const items = readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        const name = item.name;
                        if (IGNORED_DIRS.includes(name)) continue;
                        if (IGNORED_FILES.includes(name)) continue;

                        const fullItemPath = join(dir, name);
                        const relativePath = relative(baseDir, fullItemPath).replace(/\\/g, '/');

                        if (item.isDirectory()) {
                            let mtime = new Date(0);
                            try {
                                const st = statSync(fullItemPath);
                                mtime = st.mtime;
                            } catch {
                                // ignore
                            }
                            results.push({
                                name,
                                path: relativePath,
                                type: 'directory',
                                size: 0,
                                modified: mtime.toISOString(),
                            });
                            scanDir(fullItemPath, baseDir);
                            continue;
                        }

                        if (item.isFile()) {
                            try {
                                const st = statSync(fullItemPath);
                                results.push({
                                    name,
                                    path: relativePath,
                                    type: 'file',
                                    size: st.size,
                                    modified: st.mtime.toISOString(),
                                });
                            } catch {
                                // ignore
                            }
                        }
                    }
                };

                scanDir(fullPath, fullPath);

                const etag = `W/\"tree-${Date.now()}-${results.length}\"`;
                return { payload: results, etag };
            })();

            treeInflight.set(cacheKey, job);
            const resolved = await job;
            treeInflight.delete(cacheKey);

            if (TREE_CACHE_TTL_MS > 0) {
                treeCache.set(cacheKey, { expiresAt: now + TREE_CACHE_TTL_MS, etag: resolved.etag, payload: resolved.payload });
                maybeTrimCache(treeCache, 120);
            }

            sendWithEtag(reply, resolved.etag);
            if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                return reply.code(304).send();
            }

            const result = resolved.payload;

            // Sort by path to ensure hierarchy order (optional, but helpful)
            // Actually frontend builder handles it if we have all nodes.

            return result;
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to list files',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Get file content
    fastify.get<{
        Querystring: { path: string };
    }>('/api/files/content', async (request, reply) => {
        try {
            const { path } = request.query;
            if (!path) return reply.code(400).send({ error: 'Missing path' });

            if (!isSafePath(path)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(path);
            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'File not found' });
            }

            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                return reply.code(400).send({ error: 'Cannot read directory content' });
            }

            // Check if binary (simple check by extension)
            const isImage = /\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(path);

            if (isImage) {
                const buffer = readFileSync(fullPath);
                return {
                    content: `data:image/${path.split('.').pop()};base64,${buffer.toString('base64')}`,
                    isBinary: true
                };
            } else {
                const content = readFileSync(fullPath, 'utf-8');
                return { content, isBinary: false };
            }
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to read file',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    fastify.get<{
        Querystring: { q: string; path?: string; maxResults?: string; caseSensitive?: string };
    }>('/api/files/grep', async (request, reply) => {
        try {
            const q = (request.query.q || '').trim();
            if (!q) return reply.code(400).send({ error: 'Missing q' });

            const relPath = (request.query.path || '').trim();
            if (!isSafePath(relPath)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(relPath);
            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Path not found' });
            }

            const maxResults = clampInt(request.query.maxResults, 1, 500, 200);
            const caseSensitive = String(request.query.caseSensitive || '') === 'true';
            const needle = caseSensitive ? q : q.toLowerCase();

            const cacheKey = `grep:${relPath}|${caseSensitive ? '1' : '0'}|${maxResults}|${needle}`;
            const ifNoneMatch = String(request.headers['if-none-match'] || '');
            const now = Date.now();

            if (SEARCH_CACHE_TTL_MS > 0) {
                const cached = grepCache.get(cacheKey);
                if (cached && cached.expiresAt > now) {
                    sendWithEtag(reply, cached.etag);
                    if (ifNoneMatch && ifNoneMatch === cached.etag) {
                        return reply.code(304).send();
                    }
                    return cached.payload;
                }
            }

            const inflight = grepInflight.get(cacheKey);
            if (inflight) {
                const resolved = await inflight;
                sendWithEtag(reply, resolved.etag);
                if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                    return reply.code(304).send();
                }
                return resolved.payload;
            }

            const job = (async () => {
                const results: Array<{ path: string; line: number; text: string }> = [];

                const scanFile = (fullItemPath: string, relativePath: string) => {
                    if (!shouldScanTextFile(relativePath)) return;
                    let st;
                    try {
                        st = statSync(fullItemPath);
                    } catch {
                        return;
                    }
                    if (!st.isFile()) return;
                    if (st.size > 1024 * 1024) return;

                    let content = '';
                    try {
                        content = readFileSync(fullItemPath, 'utf-8');
                    } catch {
                        return;
                    }

                    const lines = content.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const hay = caseSensitive ? line : line.toLowerCase();
                        if (!hay.includes(needle)) continue;
                        results.push({
                            path: relativePath,
                            line: i + 1,
                            text: String(line).trim().slice(0, 260),
                        });
                        if (results.length >= maxResults) return true;
                    }
                    return false;
                };

                const scanDir = (dir: string, baseDir: string): boolean => {
                    const items = readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        const name = item.name;
                        if (IGNORED_DIRS.includes(name)) continue;
                        if (IGNORED_FILES.includes(name)) continue;

                        const fullItemPath = join(dir, name);
                        const relativePath = relative(baseDir, fullItemPath).replace(/\\/g, '/');

                        if (item.isDirectory()) {
                            const shouldStop = scanDir(fullItemPath, baseDir);
                            if (shouldStop) return true;
                            continue;
                        }

                        if (item.isFile()) {
                            const shouldStop = scanFile(fullItemPath, relativePath);
                            if (shouldStop) return true;
                        }
                    }
                    return false;
                };

                let rootStat;
                try {
                    rootStat = statSync(fullPath);
                } catch {
                    rootStat = null;
                }

                if (rootStat?.isDirectory()) {
                    scanDir(fullPath, fullPath);
                } else {
                    scanFile(fullPath, relPath);
                }

                const payload = { results };
                const etag = `W/\"grep-${Date.now()}-${results.length}\"`;
                return { payload, etag };
            })();

            grepInflight.set(cacheKey, job);
            const resolved = await job;
            grepInflight.delete(cacheKey);

            if (SEARCH_CACHE_TTL_MS > 0) {
                grepCache.set(cacheKey, { expiresAt: now + SEARCH_CACHE_TTL_MS, etag: resolved.etag, payload: resolved.payload });
                maybeTrimCache(grepCache, 200);
            }

            sendWithEtag(reply, resolved.etag);
            if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                return reply.code(304).send();
            }

            return resolved.payload;
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to grep files',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    fastify.get<{
        Querystring: { q?: string; path?: string; maxResults?: string };
    }>('/api/files/symbols', async (request, reply) => {
        try {
            const q = (request.query.q || '').trim();
            const relPath = (request.query.path || '').trim();
            if (!isSafePath(relPath)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(relPath);
            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Path not found' });
            }

            const maxResults = clampInt(request.query.maxResults, 1, 800, 300);
            const needle = q ? q.toLowerCase() : '';

            const cacheKey = `symbols:${relPath}|${maxResults}|${needle}`;
            const ifNoneMatch = String(request.headers['if-none-match'] || '');
            const now = Date.now();

            if (SEARCH_CACHE_TTL_MS > 0) {
                const cached = symbolsCache.get(cacheKey);
                if (cached && cached.expiresAt > now) {
                    sendWithEtag(reply, cached.etag);
                    if (ifNoneMatch && ifNoneMatch === cached.etag) {
                        return reply.code(304).send();
                    }
                    return cached.payload;
                }
            }

            const inflight = symbolsInflight.get(cacheKey);
            if (inflight) {
                const resolved = await inflight;
                sendWithEtag(reply, resolved.etag);
                if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                    return reply.code(304).send();
                }
                return resolved.payload;
            }

            const job = (async () => {
                const results: Array<{ path: string; line: number; kind: string; symbol: string }> = [];

                const isCodeFile = (p: string) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rs|c|cc|cpp|h|hpp)$/i.test(p);

                const scanFile = (absPath: string, rel: string) => {
                    if (!isCodeFile(rel)) return;
                    let st;
                    try {
                        st = statSync(absPath);
                    } catch {
                        return;
                    }
                    if (!st.isFile()) return;
                    if (st.size > 1024 * 1024) return;
                    let content = '';
                    try {
                        content = readFileSync(absPath, 'utf-8');
                    } catch {
                        return;
                    }

                    const lines = content.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const trimmed = line.trim();

                        let m: RegExpMatchArray | null = null;

                        m = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/);
                        if (m) {
                            const sym = m[1];
                            if (!needle || sym.toLowerCase().includes(needle)) {
                                results.push({ path: rel, line: i + 1, kind: 'function', symbol: sym });
                                if (results.length >= maxResults) return;
                            }
                            continue;
                        }

                        m = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z0-9_$]+)\b/);
                        if (m) {
                            const sym = m[1];
                            if (!needle || sym.toLowerCase().includes(needle)) {
                                results.push({ path: rel, line: i + 1, kind: 'class', symbol: sym });
                                if (results.length >= maxResults) return;
                            }
                            continue;
                        }

                        m = trimmed.match(/^def\s+([A-Za-z0-9_]+)\s*\(/);
                        if (m) {
                            const sym = m[1];
                            if (!needle || sym.toLowerCase().includes(needle)) {
                                results.push({ path: rel, line: i + 1, kind: 'function', symbol: sym });
                                if (results.length >= maxResults) return;
                            }
                            continue;
                        }

                        m = trimmed.match(/^class\s+([A-Za-z0-9_]+)\b/);
                        if (m && /\.py$/i.test(rel)) {
                            const sym = m[1];
                            if (!needle || sym.toLowerCase().includes(needle)) {
                                results.push({ path: rel, line: i + 1, kind: 'class', symbol: sym });
                                if (results.length >= maxResults) return;
                            }
                            continue;
                        }

                        m = trimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*\(/);
                        if (m) {
                            const sym = m[1];
                            if (!needle || sym.toLowerCase().includes(needle)) {
                                results.push({ path: rel, line: i + 1, kind: 'function', symbol: sym });
                                if (results.length >= maxResults) return;
                            }
                            continue;
                        }
                    }
                };

                const scanDir = (dir: string, baseDir: string): boolean => {
                    const items = readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        const name = item.name;
                        if (IGNORED_DIRS.includes(name)) continue;
                        if (IGNORED_FILES.includes(name)) continue;

                        const fullItemPath = join(dir, name);
                        const rel = relative(baseDir, fullItemPath).replace(/\\/g, '/');

                        if (item.isDirectory()) {
                            const stop = scanDir(fullItemPath, baseDir);
                            if (stop) return true;
                            continue;
                        }

                        if (item.isFile()) {
                            scanFile(fullItemPath, rel);
                            if (results.length >= maxResults) return true;
                        }
                    }
                    return false;
                };

                let rootStat;
                try {
                    rootStat = statSync(fullPath);
                } catch {
                    rootStat = null;
                }

                if (rootStat?.isDirectory()) {
                    scanDir(fullPath, fullPath);
                } else {
                    scanFile(fullPath, relPath);
                }

                const payload = { results };
                const etag = `W/\"symbols-${Date.now()}-${results.length}\"`;
                return { payload, etag };
            })();

            symbolsInflight.set(cacheKey, job);
            const resolved = await job;
            symbolsInflight.delete(cacheKey);

            if (SEARCH_CACHE_TTL_MS > 0) {
                symbolsCache.set(cacheKey, { expiresAt: now + SEARCH_CACHE_TTL_MS, etag: resolved.etag, payload: resolved.payload });
                maybeTrimCache(symbolsCache, 200);
            }

            sendWithEtag(reply, resolved.etag);
            if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                return reply.code(304).send();
            }

            return resolved.payload;
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to search symbols',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Save file content
    fastify.post<{
        Body: { path: string; content: string };
    }>('/api/files/content', async (request, reply) => {
        try {
            const { path, content } = request.body;
            if (!path) return reply.code(400).send({ error: 'Missing path' });

            if (!isSafePath(path)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(path);

            // Ensure parent dir exists
            const parentDir = dirname(fullPath);
            if (!existsSync(parentDir)) {
                mkdirSync(parentDir, { recursive: true });
            }

            writeFileSync(fullPath, content, 'utf-8');
            return { success: true };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to save file',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Create file or directory
    fastify.post<{
        Body: { path: string; type: 'file' | 'directory' };
    }>('/api/files/create', async (request, reply) => {
        try {
            const { path, type } = request.body;
            if (!path || !type) return reply.code(400).send({ error: 'Missing parameters' });

            if (!isSafePath(path)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(path);
            if (existsSync(fullPath)) {
                return reply.code(400).send({ error: 'Path already exists' });
            }

            if (type === 'directory') {
                mkdirSync(fullPath, { recursive: true });
            } else {
                // Ensure parent dir exists
                const parentDir = dirname(fullPath);
                if (!existsSync(parentDir)) {
                    mkdirSync(parentDir, { recursive: true });
                }
                writeFileSync(fullPath, '', 'utf-8');
            }

            return { success: true };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to create item',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Rename
    fastify.post<{
        Body: { oldPath: string; newPath: string };
    }>('/api/files/rename', async (request, reply) => {
        try {
            const { oldPath, newPath } = request.body;
            if (!oldPath || !newPath) return reply.code(400).send({ error: 'Missing parameters' });

            if (!isSafePath(oldPath) || !isSafePath(newPath)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullOldPath = getAbsolutePath(oldPath);
            const fullNewPath = getAbsolutePath(newPath);

            if (!existsSync(fullOldPath)) {
                return reply.code(404).send({ error: 'Source path not found' });
            }
            if (existsSync(fullNewPath)) {
                return reply.code(400).send({ error: 'Destination path already exists' });
            }

            renameSync(fullOldPath, fullNewPath);
            return { success: true };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to rename',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Delete
    fastify.delete<{
        Querystring: { path: string };
    }>('/api/files/delete', async (request, reply) => {
        try {
            const { path } = request.query;
            if (!path) return reply.code(400).send({ error: 'Missing path' });

            if (!isSafePath(path)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(path);
            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Path not found' });
            }

            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                rmSync(fullPath, { recursive: true, force: true });
            } else {
                unlinkSync(fullPath);
            }

            return { success: true };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to delete',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
