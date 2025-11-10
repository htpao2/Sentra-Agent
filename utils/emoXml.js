import { tag, fmt } from './xmlUtils.js';

export function thresholdsXML(th) {
  if (!th || typeof th !== 'object') return '';
  const parts = [];
  const pair = (name, obj) => {
    if (!obj) return '';
    return `<${name}>${tag('low', obj.low)}${tag('high', obj.high)}</${name}>`;
  };
  parts.push(pair('IE_A', th.IE_A));
  parts.push(pair('SN_VSTD', th.SN_VSTD));
  parts.push(pair('TF_POS', th.TF_POS));
  parts.push(pair('JP_ASTD', th.JP_ASTD));
  parts.push(tag('POS_V_CUT', th.POS_V_CUT));
  parts.push(tag('NEG_V_CUT', th.NEG_V_CUT));
  if (th.VALENCE_BANDS && typeof th.VALENCE_BANDS === 'object') {
    const vb = th.VALENCE_BANDS;
    parts.push(`<VALENCE_BANDS>${tag('negative_max', vb.negative_max)}${tag('positive_min', vb.positive_min)}</VALENCE_BANDS>`);
  }
  if (th.STRESS_BANDS && typeof th.STRESS_BANDS === 'object') {
    const sb = th.STRESS_BANDS;
    parts.push(`<STRESS_BANDS>${tag('low_max', sb.low_max)}${tag('medium_max', sb.medium_max)}</STRESS_BANDS>`);
  }
  return `<thresholds>${parts.join('')}</thresholds>`;
}

export function topEmotionsString(list, n = 6) {
  try {
    const arr = Array.isArray(list) ? list.filter(e => String(e?.label).toLowerCase() !== 'neutral').slice(0, n) : [];
    return arr.map(e => `${e.label}:${fmt(e.score)}`).join(', ');
  } catch { return ''; }
}

export function dimsText(mbti) {
  try {
    const dims = Array.isArray(mbti?.dimensions) ? mbti.dimensions : [];
    return dims.map(d => `${d.axis}:${d.letter}(${fmt(d.value)}|${d.metric})`).join(', ');
  } catch { return ''; }
}

export function buildSentraEmoSection(ua) {
  if (!ua || typeof ua !== 'object') return '';
  const aggTop = topEmotionsString(ua.top_emotions, 6);
  const mb = ua.mbti || {};
  const th = ua.thresholds || {};
  const summary = [
    tag('total_events', ua.total_events),
    tag('avg_valence', fmt(ua.avg_valence)),
    tag('avg_arousal', fmt(ua.avg_arousal)),
    tag('avg_dominance', fmt(ua.avg_dominance)),
    tag('avg_stress', fmt(ua.avg_stress)),
    tag('v_std', fmt(ua.v_std)),
    tag('a_std', fmt(ua.a_std)),
    tag('d_std', fmt(ua.d_std)),
    tag('pos_ratio', fmt(ua.pos_ratio)),
    tag('neg_ratio', fmt(ua.neg_ratio)),
    tag('agg_top_emotions', aggTop || '(none)')
  ].join('');
  const mbtiParts = [
    tag('type', mb.type || ''),
    tag('confidence', fmt(mb.confidence)),
    tag('dims', dimsText(mb) || '')
  ];
  if (mb.dominant_emotion && String(mb.dominant_emotion).toLowerCase() !== 'neutral') {
    mbtiParts.push(tag('dominant_emotion', mb.dominant_emotion));
  }
  const mbti = mbtiParts.join('');
  const cmp = (() => {
    const blocks = [];
    if (th.IE_A) blocks.push(`<avg_arousal_vs_IE_A>${tag('value', fmt(ua.avg_arousal))}${tag('low', th.IE_A.low)}${tag('high', th.IE_A.high)}</avg_arousal_vs_IE_A>`);
    if (th.SN_VSTD) blocks.push(`<v_std_vs_SN_VSTD>${tag('value', fmt(ua.v_std))}${tag('low', th.SN_VSTD.low)}${tag('high', th.SN_VSTD.high)}</v_std_vs_SN_VSTD>`);
    if (th.TF_POS) blocks.push(`<pos_ratio_vs_TF_POS>${tag('value', fmt(ua.pos_ratio))}${tag('low', th.TF_POS.low)}${tag('high', th.TF_POS.high)}</pos_ratio_vs_TF_POS>`);
    if (th.JP_ASTD) blocks.push(`<a_std_vs_JP_ASTD>${tag('value', fmt(ua.a_std))}${tag('low', th.JP_ASTD.low)}${tag('high', th.JP_ASTD.high)}</a_std_vs_JP_ASTD>`);
    if (th.VALENCE_BANDS) {
      const vb = th.VALENCE_BANDS;
      blocks.push(`<avg_valence_vs_VALENCE_BANDS>${tag('value', fmt(ua.avg_valence))}${tag('negative_max', vb.negative_max)}${tag('positive_min', vb.positive_min)}</avg_valence_vs_VALENCE_BANDS>`);
    }
    if (th.STRESS_BANDS) {
      const sb = th.STRESS_BANDS;
      blocks.push(`<avg_stress_vs_STRESS_BANDS>${tag('value', fmt(ua.avg_stress))}${tag('low_max', sb.low_max)}${tag('medium_max', sb.medium_max)}</avg_stress_vs_STRESS_BANDS>`);
    }
    return `<compare>${blocks.join('')}</compare>`;
  })();
  return `<sentra-emo><summary>${summary}</summary><mbti>${mbti}</mbti>${thresholdsXML(th)}${cmp}</sentra-emo>`;
}
