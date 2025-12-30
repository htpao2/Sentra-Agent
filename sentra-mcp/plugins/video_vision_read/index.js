import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import OpenAI from 'openai';
import mime from 'mime-types';
import { httpRequest } from '../../src/utils/http.js';

function isTimeoutError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  const code = String(e?.code || '').toUpperCase();
  return (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'ECONNABORTED' ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  );
}

function buildAdvice(kind, ctx = {}) {
  const personaHint = '请结合你当前的预设/人设继续作答：当视频理解失败时，要说明原因（路径/大小/网络/格式/接口），给替代方案（换文件/压缩/截取片段/重试），并引导用户补充可用输入。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我需要你提供视频列表（videos）以及你想让我分析的具体问题（prompt）。当前参数不完整，所以我没法开始分析。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 videos：URL 或本地绝对路径数组，例如：["E:/a.mp4"]',
        '提供 prompt：你希望我关注什么（剧情/人物/字幕/动作/异常片段等）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'VIDEO_TOO_LARGE') {
    return {
      suggested_reply: '我可以分析视频，但你提供的视频体积超过了当前的大小限制，所以这次没法读取。你可以把视频压缩一下、截取关键片段，或者把限制调大后再试。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '把视频压缩/转码（降低码率或分辨率）',
        '截取 10-30 秒的关键片段再上传/再给路径',
        `如果你确认环境允许，可以调大 VIDEO_VISION_MAX_SIZE_MB（当前上限见错误信息）`,
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'INVALID_PATH') {
    return {
      suggested_reply: '我没法读取你提供的本地视频路径：本插件要求本地视频必须是“绝对路径”。你把完整路径发我一下，我就能继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '使用绝对路径，例如：E:/videos/demo.mp4 或 C:/Users/.../a.mp4',
        '确认文件存在且有读取权限',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我在读取/分析视频时卡住了，像是网络或接口超时了。我可以先给你一个不依赖工具的分析思路，或者我们稍后重试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试，或减少视频数量/缩短视频片段',
        '如果是 URL 视频，建议换更稳定的直链或先下载成本地文件再分析',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试分析你提供的视频，但这次工具执行失败了。我可以先根据你的问题给你一套排查/分析思路；如果你愿意，我们也可以换一个更小/更清晰的视频片段再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '提供更短的片段或更少的视频文件',
      '告诉我你最关心的时间点/画面（如“00:35-00:50”）',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

function isHttpUrl(s) {
  try { const u = new URL(String(s)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

async function readVideoAsBase64WithMime(src) {
  let buf; let type = '';
  if (isHttpUrl(src)) {
    const res = await httpRequest({
      method: 'GET',
      url: src,
      timeoutMs: 60000,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`fetch video failed: ${res.status}`);
    buf = Buffer.from(res.data);
    const ct = (res.headers?.['content-type'] || '').split(';')[0].trim();
    if (ct && ct.startsWith('video/')) type = ct;
    if (!type) {
      try { const u = new URL(String(src)); type = mime.lookup(u.pathname) || ''; } catch {}
    }
  } else {
    // treat as local absolute path
    const p = path.resolve(src);
    if (!path.isAbsolute(p)) {
      throw new Error('local video path must be absolute');
    }
    buf = await fs.readFile(p);
    type = String(mime.lookup(p) || '');
  }
  if (!type || !type.startsWith('video/')) {
    // fallback to a common video type
    type = 'video/mp4';
  }
  
  const dataUri = `data:${type};base64,${buf.toString('base64')}`;
  return { uri: dataUri, mime: type, size: buf.length };
}

export default async function handler(args = {}, options = {}) {
  const videos = Array.isArray(args.videos) ? args.videos : [];
  const prompt = String(args.prompt || '').trim();
  if (!videos.length) return { success: false, code: 'INVALID', error: 'videos is required (array of urls or absolute paths)', advice: buildAdvice('INVALID', { tool: 'video_vision_read' }) };
  if (!prompt) return { success: false, code: 'INVALID', error: 'prompt is required', advice: buildAdvice('INVALID', { tool: 'video_vision_read', videos_count: videos.length }) };

  // plugin-level env
  const penv = options?.pluginEnv || {};
  const apiKey = penv.VIDEO_VISION_API_KEY || process.env.VIDEO_VISION_API_KEY || config.llm.apiKey;
  const baseURL = penv.VIDEO_VISION_BASE_URL || process.env.VIDEO_VISION_BASE_URL || config.llm.baseURL;
  const model = penv.VIDEO_VISION_MODEL || process.env.VIDEO_VISION_MODEL || config.llm.model;
  const maxVideoSizeMB = Number(penv.VIDEO_VISION_MAX_SIZE_MB || process.env.VIDEO_VISION_MAX_SIZE_MB || 50);

  const oai = new OpenAI({ apiKey, baseURL });

  logger.info?.('video_vision_read:config', { label: 'PLUGIN', baseURL, model, videoCount: videos.length, maxVideoSizeMB });

  // prepare vision messages: a single user message with mixed text+videos
  const items = [];
  if (prompt) items.push({ type: 'text', text: prompt });
  
  // read all videos and build data URIs with detected MIME in parallel
  let prepared;
  try {
    prepared = await Promise.all(videos.map(async (src) => {
      const result = await readVideoAsBase64WithMime(src);
      // 检查视频大小限制
      const sizeMB = result.size / (1024 * 1024);
      if (sizeMB > maxVideoSizeMB) {
        throw new Error(`Video size ${sizeMB.toFixed(2)}MB exceeds limit of ${maxVideoSizeMB}MB: ${src}`);
      }
      logger.info?.('video_vision_read:video_loaded', { label: 'PLUGIN', src, mime: result.mime, sizeMB: sizeMB.toFixed(2) });
      return result;
    }));
  } catch (e) {
    logger.warn?.('video_vision_read:load_video_failed', { label: 'PLUGIN', error: String(e?.message || e) });
    const msg = String(e?.message || e);
    const lower = msg.toLowerCase();
    const isTimeout = isTimeoutError(e);
    const tooLarge = lower.includes('exceeds limit');
    const invalidPath = lower.includes('must be absolute');
    const code = isTimeout ? 'TIMEOUT' : (tooLarge ? 'VIDEO_TOO_LARGE' : (invalidPath ? 'INVALID_PATH' : 'VIDEO_READ_ERR'));
    const adviceKind = isTimeout ? 'TIMEOUT' : (tooLarge ? 'VIDEO_TOO_LARGE' : (invalidPath ? 'INVALID_PATH' : 'ERR'));
    return { success: false, code, error: msg, advice: buildAdvice(adviceKind, { tool: 'video_vision_read', maxVideoSizeMB, videos_count: videos.length }) };
  }
  
  // 根据OpenAI API格式，视频使用 video_url 而不是 image_url
  for (const it of prepared) {
    items.push({ 
      type: 'video_url', 
      video_url: { url: it.uri } 
    });
  }

  const messages = [
    { role: 'user', content: items }
  ];

  try {
    logger.info?.('video_vision_read:calling_api', { label: 'PLUGIN', model, itemCount: items.length });
    const res = await oai.chat.completions.create({ model, messages });
    const content = res?.choices?.[0]?.message?.content || '';
    logger.info?.('video_vision_read:api_success', { label: 'PLUGIN', responseLength: content?.length || 0 });
    
    // 返回字段：prompt、视频描述与摘要统计
    const formats = Array.from(new Set((prepared || []).map((x) => x.mime))).filter(Boolean);
    const totalSizeMB = (prepared || []).reduce((sum, x) => sum + x.size, 0) / (1024 * 1024);
    
    return { 
      success: true, 
      data: { 
        prompt, 
        description: content, 
        video_count: videos.length, 
        formats,
        total_size_mb: totalSizeMB.toFixed(2)
      } 
    };
  } catch (e) {
    logger.warn?.('video_vision_read:request_failed', { label: 'PLUGIN', error: String(e?.message || e), stack: e?.stack });
    const isTimeout = isTimeoutError(e);
    return { success: false, code: isTimeout ? 'TIMEOUT' : 'ERR', error: String(e?.message || e), advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'video_vision_read', videos_count: videos.length }) };
  }
}
