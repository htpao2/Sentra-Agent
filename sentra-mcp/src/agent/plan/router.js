import { config } from '../../config/index.js';
import { embedTexts } from '../../openai/client.js';
import logger from '../../logger/index.js';

/**
 * 构造用于重排序的插件“文档文本”
 * - 严格只用 meta.realWorldAction（真实能力描述）
 * - 可选兜底：当 realWorldAction 为空时，是否回退到 description（受 RERANK_USE_DESC_FALLBACK 控制）
 */
export function buildToolDoc(t) {
  const rw = String(t?.meta?.realWorldAction || '').trim();
  if (rw) return rw;
  const useFallback = (config.rerank?.useDescFallback !== false)
    || String(process.env.RERANK_USE_DESC_FALLBACK || '').toLowerCase() === 'true';
  return useFallback ? String(t?.description || '').trim() : '';
}

/**
 * 调用 SiliconFlow 在线重排序
 * 仅关注 results: [{ index, relevance_score }]
 */
function buildRerankUrl(baseURL) {
  const root = String(baseURL || 'https://api.siliconflow.cn').replace(/\/+$/, '');
  if (/\/rerank$/i.test(root)) return root;                // e.g. https://yuanplus.chat/v1/rerank
  if (/\/v\d+$/i.test(root)) return root + '/rerank';     // e.g. https://yuanplus.chat/v1 -> +/rerank
  return root + '/v1/rerank';                               // e.g. https://yuanplus.chat -> +/v1/rerank
}

export async function rerankDocumentsSiliconFlow({ query, documents, baseURL, apiKey, model, topN, timeoutMs }) {
  const url = buildRerankUrl(baseURL);
  const docsClean = (documents || [])
    .map((d) => (typeof d === 'string' ? d : String(d?.text || '')))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const q = String(query || '').trim();
  if (!q || docsClean.length === 0) {
    throw new Error(`Invalid rerank inputs: query='${q}', docs=${docsClean.length}`);
  }
  const payload = { model: model || 'BAAI/bge-reranker-v2-m3', query: q, documents: docsClean };
  // -1 或 <=0 代表不限制：为确保服务端全量返回，直接设置为文档总数
  if (!Number.isFinite(topN) || Number(topN) <= 0) {
    payload.top_n = docsClean.length;
  } else if (Number.isFinite(topN) && topN > 0) {
    const tn = Math.max(1, Math.min(Number(topN), docsClean.length));
    payload.top_n = tn;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs || 12000)));
  try {
    logger.debug?.('Rerank request', { label: 'RERANK', url, model: payload.model, docs: docsClean.length, top_n: payload.top_n });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const preview = text ? ` ${text.slice(0, 200)}` : '';
      throw new Error(`Rerank HTTP ${res.status}:${preview}`);
    }
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.map(r => ({ index: Number(r.index), score: Number(r.relevance_score || 0) }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 重排序工具清单
 * @param {Object} params
 * @param {Array} params.manifest - 工具清单
 * @param {string} params.objective - 目标描述（兜底）
 * @param {number} params.candidateK - 候选数量
 * @param {number} params.topN - 返回Top N
 * @returns {Promise<{manifest: Array, indices: Array, scores: Array}>}
 */
export async function rerankManifest({ manifest, objective, candidateK, topN }) {
  if (!Array.isArray(manifest)) return { manifest: [], indices: [], scores: [] };
  const L = manifest.length;
  if (L === 0) return { manifest: [], indices: [], scores: [] };

  const query = String(objective || '').trim();
  if (!query) return { manifest, indices: manifest.map((_, i) => i), scores: [] };

  // 构建工具文档
  const docs = manifest.map((t) => buildToolDoc(t));

  try {
    // 1) 余弦粗排（快速）：取前 candidateK 个候选
    const embs = await embedTexts({ texts: [query, ...docs] });
    const qv = embs[0] || [];
    const dvs = embs.slice(1);
    const sims = dvs.map((v) => {
      let dot = 0, na = 0, nb = 0;
      const L = Math.min(v.length, qv.length);
      for (let i = 0; i < L; i++) { const x = qv[i]; const y = v[i]; dot += x * y; na += x * x; nb += y * y; }
      if (na === 0 || nb === 0) return 0;
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    });
    const orderByCos = sims.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s);
    // -1 或 <=0 代表不过滤：直接全量进入精排
    const Kraw = Number.isFinite(candidateK) ? Number(candidateK) : Number(config.rerank?.candidateK ?? 50);
    const K = (Kraw <= 0) ? orderByCos.length : Math.max(1, Kraw);
    const preIdx = orderByCos.slice(0, Math.min(K, orderByCos.length)).map((x) => x.i);
    // 仅对在线精排阶段清洗空文档：记录 (原索引, 文本)
    const prePairs = preIdx.map((i) => ({ i, text: String(docs[i] || '').trim() })).filter(p => !!p.text);
    const preDocs = prePairs.map(p => p.text);

    // 2) 在线精排（可选，多段查询聚合）
    const enable = (config.rerank?.enable !== false) && String(process.env.RERANK_ENABLE || 'true').toLowerCase() !== 'false';
    const apiKey = process.env.RERANK_API_KEY || config.rerank?.apiKey || '';
    const tnRaw = Number.isFinite(topN) ? Number(topN) : Number(process.env.RERANK_TOP_N) || Number(config.rerank?.topN) || preDocs.length;
    const finalTopN = (tnRaw <= 0) ? preDocs.length : Math.max(1, Math.min(tnRaw, preDocs.length));
    if (enable && apiKey) {
      try {
        const results = await rerankDocumentsSiliconFlow({
          query,
          documents: preDocs,
          baseURL: process.env.RERANK_BASE_URL || config.rerank?.baseURL,
          apiKey,
          model: process.env.RERANK_MODEL || config.rerank?.model,
          topN: finalTopN,
          timeoutMs: Number(process.env.RERANK_TIMEOUT_MS || config.rerank?.timeoutMs || 12000),
        });
        const rankedIndices = (results || [])
          .filter((r) => Number.isInteger(r.index) && r.index >= 0)
          .map((r) => prePairs[r.index]?.i)
          .filter((i) => Number.isInteger(i));
        const rankedManifest = rankedIndices.slice(0, finalTopN).map((i) => manifest[i]);
        const rankedScores = rankedIndices.slice(0, finalTopN).map(() => 0);
        logger.info?.('重排序完成', { label: 'RERANK', topN: rankedIndices.length, topAi: rankedManifest?.[0]?.aiName, query });
        if (rankedManifest.length > 0) {
          return { manifest: rankedManifest, indices: rankedIndices.slice(0, finalTopN), scores: rankedScores };
        }
      } catch (e) {
        logger.warn?.('在线重排序失败，回退到余弦粗排', {
          label: 'RERANK',
          error: String(e),
          query,
          preDocs: preDocs.length,
          finalTopN,
        });
      }
    }

    // 3) 无在线重排或失败：沿用余弦粗排，并限制到 finalTopN
    const fallbackRequestedTopN = Number.isFinite(topN) ? Number(topN) : (Number(process.env.RERANK_TOP_N) || Number(config.rerank?.topN) || preDocs.length);
    const fallbackTopN = (fallbackRequestedTopN <= 0)
      ? (prePairs.length || preIdx.length)
      : Math.max(1, Math.min(Number(fallbackRequestedTopN), prePairs.length || preIdx.length));
    const rankedIndices = (prePairs.length ? prePairs.map(p => p.i) : preIdx).slice(0, fallbackTopN);
    const rankedManifest = rankedIndices.map((i) => manifest[i]);
    const rankedScores = rankedIndices.map((i) => sims[i] ?? 0);
    logger.info?.('重排序(仅粗排)完成', { label: 'RERANK', topN: rankedIndices.length, topAi: rankedManifest?.[0]?.aiName, topScore: rankedScores?.[0] });
    return { manifest: rankedManifest, indices: rankedIndices, scores: rankedScores };
  } catch (e) {
    logger.warn?.('重排序异常，使用原始清单', { label: 'RERANK', error: String(e) });
    return { manifest, indices: manifest.map((_, i) => i), scores: [] };
  }
}

export default { buildToolDoc, rerankDocumentsSiliconFlow, rerankManifest };
