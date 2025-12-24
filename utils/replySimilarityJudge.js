import { createLogger } from './logger.js';
import { computeSemanticSimilarity } from './messageBundler.js';
import { getEnv, getEnvBool } from './envHotReloader.js';
import { ConversationAnalyzer } from '../components/gate/analyzer.js';

const logger = createLogger('ReplySimilarityJudge');

function getSendDedupMinSimilarity() {
  const raw = getEnv('SEND_FUSION_DEDUP_MIN_SIMILARITY', '0.92');
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : 0.92;
}

function getSendDedupLocalDebug() {
  return getEnvBool('SEND_FUSION_DEDUP_LOCAL_DEBUG', false);
}

function buildAnalyzer() {
  try {
    return new ConversationAnalyzer({
      contextWindow: 4,
      maxSimilarity: 1,
      debug: getSendDedupLocalDebug()
    });
  } catch (e) {
    logger.warn('初始化 ConversationAnalyzer 失败，将仅使用 Embedding 相似度', { err: String(e) });
    return null;
  }
}

let sharedAnalyzer = null;

function getAnalyzer() {
  if (sharedAnalyzer === null) {
    sharedAnalyzer = buildAnalyzer();
  }
  return sharedAnalyzer;
}

function computeLocalSimilarity(a, b) {
  const analyzer = getAnalyzer();
  if (!analyzer) return null;

  try {
    const result = analyzer.analyze(a, [b], {});
    const f = result && result.features ? result.features : {};
    const sims = [
      typeof f.jaccardMax === 'number' ? f.jaccardMax : null,
      typeof f.overlapCoefMax === 'number' ? f.overlapCoefMax : null,
      typeof f.simhashNearnessMax === 'number' ? f.simhashNearnessMax : null,
      typeof f.minhashNearnessMax === 'number' ? f.minhashNearnessMax : null
    ].filter((x) => x != null && !Number.isNaN(x));

    if (!sims.length) return null;
    return Math.max(...sims);
  } catch (e) {
    logger.warn('本地相似度计算失败，将忽略本地特征', { err: String(e) });
    return null;
  }
}

export async function judgeReplySimilarity(textA, textB) {
  const localDebug = getSendDedupLocalDebug();
  const a = (textA || '').trim();
  const b = (textB || '').trim();
  if (!a || !b) {
    return { areSimilar: false, similarity: null, source: 'none' };
  }

  let embSim = null;
  try {
    embSim = await computeSemanticSimilarity(a, b);
  } catch {
    embSim = null;
  }

  let localSim = null;
  if (a.length <= 512 && b.length <= 512) {
    localSim = computeLocalSimilarity(a, b);
  }

  const hasEmb = typeof embSim === 'number' && !Number.isNaN(embSim);
  const hasLocal = typeof localSim === 'number' && !Number.isNaN(localSim);

  if (localDebug) {
    try {
      logger.debug('judgeReplySimilarity 输入与初始相似度', {
        aPreview: a.slice(0, 80),
        bPreview: b.slice(0, 80),
        embSim,
        localSim,
        hasEmb,
        hasLocal
      });
    } catch {}
  }

  let combined = null;
  if (hasEmb && hasLocal) {
    combined = (embSim + localSim) / 2;
  } else if (hasEmb) {
    combined = embSim;
  } else if (hasLocal) {
    combined = localSim;
  }

  if (combined == null) {
    return { areSimilar: false, similarity: null, source: 'none' };
  }

  const threshold = getSendDedupMinSimilarity();

  if (localDebug) {
    try {
      logger.debug('judgeReplySimilarity 综合相似度', {
        combined,
        threshold,
        embSim,
        localSim
      });
    } catch {}
  }

  return { areSimilar: combined >= threshold, similarity: combined, source: 'local_only' };
}
