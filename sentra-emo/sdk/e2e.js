import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import SentraEmo from './index.js';

async function tryLoadEnv() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');
  const candidates = [path.join(root, '.env'), path.join(root, '.env.example')];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(p, 'utf-8');
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || line.startsWith('#')) continue;
          const eq = line.indexOf('=');
          if (eq <= 0) continue;
          const key = line.slice(0, eq).trim();
          let val = line.slice(eq + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          process.env[key] = val;
        }
        return p;
      }
    } catch {}
  }
  return null;
}

async function main() {
  const loaded = await tryLoadEnv();
  const baseURL = `http://${process.env.APP_HOST || '127.0.0.1'}:${process.env.APP_PORT || '7200'}`;
  console.log('Base URL:', baseURL);
  if (loaded) console.log('Loaded env from:', loaded);

  const sdk = new SentraEmo({ baseURL, timeout: 60000 });
  const userid = '2166683295';
  const username = '之一一';

  // health
  const h = await sdk.health();
  console.log('health:', h);

  // models
  const m = await sdk.models();
  console.log(m.vad.map_path, m.vad.alias_path, m.vad.unknown_labels_count);
  const selSent = m?.models?.sentiment?.selected;
  const selEmo = m?.models?.emotion?.selected;
  console.log('models.selected:', { sentiment: selSent, emotion: selEmo });

  // single analyze (with user tracking)
  const t1 = '乐，你算什么？';
  const r1 = await sdk.analyze(t1, { userid, username });
  console.log('analyze.user.updated_at:', r1?.user?.updated_at);

  const t3 = '最近压力大，晚上睡不着，老是失眠';
  const r3 = await sdk.analyze(t3, { userid, username });
  console.log('analyze.stress:', r3?.stress);
  
  // batch analyze (server-first, fallback to client concurrent)
  const texts = ['今天很开心，效率拉满！', '最近压力有点大，晚上睡不着。'];
  const r2 = await sdk.analyzeBatch(texts, { userid, username });
  console.log('batch size:', Array.isArray(r2) ? r2.length : 0);
  if (Array.isArray(r2)) {
    r2.forEach((item, i) => {
      if (item && item.error) {
        console.log(`batch[${i}] error:`, item.error);
      } else {
        console.log(`batch[${i}].user.count:`, r2[i]?.user?.count);
      }
    });
  }

  // retrieve user state and recent events
  const state = await sdk.userState(userid);
  console.log('userState:', { count: state.count, stress: state.stress, vad: state.vad, updated_at: state.updated_at });
  const topEmos = Array.isArray(state.emotions)
    ? state.emotions.slice(0, 6).map(e => `${e.label}:${(e.score ?? 0).toFixed(2)}`)
    : [];
  console.log('userCurrentEmotions(top6):', topEmos.join(', '));

  // analytics summary
  const daysN = Number(process.env.E2E_USER_DAYS || 7);
  const analytics = await sdk.userAnalytics(userid, { days: daysN });
  const mbti = analytics.mbti || {};
  const thr = analytics.thresholds || {};
  const dims = Array.isArray(mbti.dimensions)
    ? mbti.dimensions.map(d => `${d.axis}:${d.letter}(${(d.value ?? 0).toFixed(2)}|${d.metric})`).join(', ')
    : '(none)';
  const aggTop = Array.isArray(analytics.top_emotions)
    ? analytics.top_emotions.slice(0, 6).map(e => `${e.label}:${(e.score ?? 0).toFixed(2)}`).join(', ')
    : '(none)';
  console.log(`userAnalytics(last ${daysN}d):`, {
    total: analytics.total_events,
    avg_valence: analytics.avg_valence,
    avg_arousal: analytics.avg_arousal,
    avg_dominance: analytics.avg_dominance,
    avg_stress: analytics.avg_stress,
    first_event: analytics.first_event,
    last_event: analytics.last_event,
    v_std: analytics.v_std,
    a_std: analytics.a_std,
    d_std: analytics.d_std,
    pos_ratio: analytics.pos_ratio,
    neg_ratio: analytics.neg_ratio,
    agg_top_emotions: aggTop,
    mbti_type: mbti.type,
    mbti_confidence: mbti.confidence,
    mbti_dims: dims,
    mbti_dominant_emotion: mbti.dominant_emotion,
  });
  console.log('thresholds:', {
    IE_A: thr.IE_A,
    SN_VSTD: thr.SN_VSTD,
    TF_POS: thr.TF_POS,
    JP_ASTD: thr.JP_ASTD,
    POS_V_CUT: thr.POS_V_CUT,
    NEG_V_CUT: thr.NEG_V_CUT,
    VALENCE_BANDS: thr.VALENCE_BANDS,
    STRESS_BANDS: thr.STRESS_BANDS,
  });
  console.log('mbti_detail:', {
    traits_en: Array.isArray(mbti.traits_en) ? mbti.traits_en.join(', ') : '(none)',
    explain_en: mbti.explain_en,
    compare: {
      avg_arousal_vs_IE_A: { value: analytics.avg_arousal, thresholds: thr.IE_A },
      v_std_vs_SN_VSTD: { value: analytics.v_std, thresholds: thr.SN_VSTD },
      pos_ratio_vs_TF_POS: { value: analytics.pos_ratio, thresholds: thr.TF_POS },
      a_std_vs_JP_ASTD: { value: analytics.a_std, thresholds: thr.JP_ASTD },
      avg_valence_vs_VALENCE_BANDS: { value: analytics.avg_valence, bands: thr.VALENCE_BANDS },
      avg_stress_vs_STRESS_BANDS: { value: analytics.avg_stress, bands: thr.STRESS_BANDS },
    }
  });

  // visualize via Python module (requires custom font)
  await runPythonVisualization({ userid });
}

main().catch((err) => {
  console.error('E2E failed:', err?.stack || err);
  process.exitCode = 1;
});

async function runPythonVisualization({ userid }) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '..');
  const py = process.env.PYTHON || 'python';

  // Require explicit VISUAL_FONT_PATH (no auto-detection)
  const env = { ...process.env };
  const fontPathRaw = env.VISUAL_FONT_PATH;
  const fontPath = fontPathRaw && path.isAbsolute(fontPathRaw)
    ? fontPathRaw
    : (fontPathRaw ? path.join(repoRoot, fontPathRaw) : null);
  if (!fontPath || !fs.existsSync(fontPath)) {
    console.error('✗ 可视化需要自定义字体: 请设置 VISUAL_FONT_PATH 并确保文件存在');
    console.error('  示例: VISUAL_FONT_PATH=fonts/SourceHanSansSC-Regular.otf');
    console.error('  当前解析路径:', fontPath || '(空)');
    throw new Error('missing VISUAL_FONT_PATH for visualization');
  }
  env.VISUAL_FONT_PATH = fontPath; // 传递绝对路径给 Python

  console.log('VISUAL_FONT_PATH =', env.VISUAL_FONT_PATH);

  // 1) 用户情绪趋势图
  {
    const pyCode = `from visualizer import generate_user_emotion_chart; print(generate_user_emotion_chart(userid='${userid}', days=7, output_dir='output'))`;
    console.log('visualize: generate_user_emotion_chart ...');
    const r = spawnSync(py, ['-c', pyCode], { cwd: repoRoot, stdio: 'inherit', env });
    if (r.status !== 0) throw new Error('generate_user_emotion_chart failed');
  }

  // 2) 全局情感分布图
  {
    const pyCode = `from visualizer import generate_sentiment_distribution_chart; print(generate_sentiment_distribution_chart(days=7, output_dir='output'))`;
    console.log('visualize: generate_sentiment_distribution_chart ...');
    const r = spawnSync(py, ['-c', pyCode], { cwd: repoRoot, stdio: 'inherit', env });
    if (r.status !== 0) throw new Error('generate_sentiment_distribution_chart failed');
  }

  // 3) 用户情绪均值表格图
  {
    const pyCode = `from visualizer import generate_user_emotion_table_chart; print(generate_user_emotion_table_chart(userid='${userid}', days=7, output_dir='output'))`;
    console.log('visualize: generate_user_emotion_table_chart ...');
    const r = spawnSync(py, ['-c', pyCode], { cwd: repoRoot, stdio: 'inherit', env });
    if (r.status !== 0) throw new Error('generate_user_emotion_table_chart failed');
  }
}
