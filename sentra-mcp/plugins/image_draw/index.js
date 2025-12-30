import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import OpenAI from 'openai';
import mime from 'mime-types';
import { httpRequest } from '../../src/utils/http.js';

// 模型简化：仅使用环境变量 DRAW_MODEL（未配置则回退全局模型）

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
  const personaHint = '请结合你当前的预设/人设继续作答：当绘图失败时，要解释失败原因、给替代方案（改提示词/降低复杂度/重试/换模式），并引导用户补充更具体需求。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我现在还没拿到要画的内容（prompt 为空），所以没法开始生成图片。你把想画的主题/风格/构图描述发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '补充 prompt：主体 + 风格 + 场景 + 细节（例如“赛博朋克雨夜街头，霓虹灯，电影感，广角”）',
        '如有偏好可加：画风（写实/二次元/像素/水彩）+ 色调 + 分辨率',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我刚才在生成图片时卡住了，像是接口/网络超时了。我可以先基于你的描述给你一版更容易生成的提示词，或者我们稍后重试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试或降低 prompt 复杂度',
        '改成更明确的主体/镜头/风格关键词，减少长段落描述',
        '如支持可切换模式（images/chat）或调整尺寸',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'NO_IMAGE') {
    return {
      suggested_reply: '我这次确实尝试生成图片了，但接口没有返回可用的图像数据。我们可以换个描述方式或稍后再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '换一版更明确的 prompt（主体/风格/场景）',
        '稍后重试或更换模型/尺寸（如果环境支持）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'NO_MD_IMAGE') {
    return {
      suggested_reply: '我刚才已经让模型画图并输出 Markdown 图片，但它没有按要求给出图片链接/图片数据，所以这次生成失败了。我可以帮你把提示词改得更“强约束”，然后再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '缩短提示词、明确要求“必须输出 1 个 Markdown 图片链接”',
        '更换描述方式：先给主体，再给风格，再给细节',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'NO_LOCAL_IMAGE') {
    return {
      suggested_reply: '我拿到了图片链接/数据的线索，但在把图片保存成可用的本地文件时失败了，所以没法把结果稳定地交付给你。我们可以重试下载，或者换一种生成方式。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试（可能是网络/链接失效）',
        '切换生成模式或换一个更稳定的图片来源',
        '如果你允许只返回外链（不落地文件），也可以告诉我',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试帮你生成图片，但这次工具执行失败了。我可以先基于你的需求给你一版更稳的提示词，并给你几种替代方案（重试/换风格/换模式）。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '建议你补充：风格、画面主体、构图/镜头、氛围色调',
      '我也可以先给你 3-5 条不同风格的提示词供选择',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

function hasMarkdownImage(s) {
  return /!\[[^\]]*\]\([^)]+\)/i.test(String(s || ''));
}

function isHttpUrl(s) {
  try { const u = new URL(String(s)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

function isFileUrl(s) {
  try { const u = new URL(String(s)); return u.protocol === 'file:'; } catch { return false; }
}

function toAbsoluteLocalPath(target) {
  const raw = String(target || '').trim();
  if (!raw) return null;
  if (isHttpUrl(raw)) return null;
  if (/^data:/i.test(raw)) return null;
  if (isFileUrl(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  const p = path.resolve(raw);
  if (!path.isAbsolute(p)) return null;
  return p;
}

function formatLocalMarkdownImage(target, alt = 'image') {
  const normalized = String(target || '').replace(/\\/g, '/');
  return `![${alt}](${normalized})`;
}

function collectLocalMarkdownImages(md) {
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const lines = [];
  let m;
  while ((m = re.exec(md)) !== null) {
    const alt = m[1] || '';
    const url = String(m[2] || '').trim();
    if (!url) continue;
    const abs = toAbsoluteLocalPath(url);
    if (!abs) continue;
    lines.push(formatLocalMarkdownImage(String(abs).replace(/\\/g, '/'), alt));
  }
  return lines.join('\n');
}

async function collectVerifiedLocalMarkdownImages(md) {
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const lines = [];
  let m;
  while ((m = re.exec(md)) !== null) {
    const alt = m[1] || '';
    const url = String(m[2] || '').trim();
    if (!url) continue;
    const abs = toAbsoluteLocalPath(url);
    if (!abs) continue;
    try {
      await fs.access(abs);
      lines.push(formatLocalMarkdownImage(String(abs).replace(/\\/g, '/'), alt));
    } catch {
      continue;
    }
  }
  return lines.join('\n');
}

async function downloadImagesAndRewrite(md, prefix = 'draw') {
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const urls = new Set();
  const dataUrls = new Set();
  let m;
  while ((m = re.exec(md)) !== null) {
    const target = String(m[2] || '').trim();
    if (!target) continue;
    if (isHttpUrl(target)) urls.add(target);
    else if (/^data:image\//i.test(target)) dataUrls.add(target);
  }
  if (urls.size === 0 && dataUrls.size === 0) return md;

  const baseDir = 'artifacts';
  await fs.mkdir(baseDir, { recursive: true });

  const map = new Map();
  const dataMap = new Map();
  let idx = 0;

  // 下载 HTTP 图片
  for (const url of urls) {
    try {
      const res = await httpRequest({
        method: 'GET',
        url,
        timeoutMs: 60000,
        responseType: 'arraybuffer',
        validateStatus: () => true,
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(res.data);
      let ct = (res.headers?.['content-type'] || '').split(';')[0].trim();
      if (!ct) {
        try { const u = new URL(url); ct = String(mime.lookup(u.pathname) || ''); } catch {}
      }
      let ext = '';
      if (ct && ct.startsWith('image/')) {
        const e = mime.extension(ct);
        if (e) ext = `.${e}`;
      }
      if (!ext) {
        try { const u = new URL(url); ext = path.extname(u.pathname) || '.png'; } catch { ext = '.png'; }
      }
      const name = `${prefix}_${Date.now()}_${idx++}${ext}`;
      const abs = path.resolve(baseDir, name);
      await fs.writeFile(abs, buf);
      const absMd = String(abs).replace(/\\/g, '/');
      map.set(url, absMd);
    } catch (e) {
      logger.warn?.('image_draw:download_failed', { label: 'PLUGIN', url, error: String(e?.message || e) });
    }
  }

  // 处理 data:image/...;base64,...
  for (const dataUrl of dataUrls) {
    try {
      const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/i);
      if (!match) continue;
      const mimeType = (match[1] || '').trim() || 'image/png';
      const b64 = String(match[2] || '').trim().replace(/\s+/g, '');
      if (!b64) continue;
      const buf = Buffer.from(b64, 'base64');
      let ext = '';
      if (mimeType && mimeType.toLowerCase().startsWith('image/')) {
        const e = mime.extension(mimeType);
        if (e) ext = `.${e}`;
      }
      if (!ext) ext = '.png';
      const name = `${prefix}_${Date.now()}_${idx++}${ext}`;
      const abs = path.resolve(baseDir, name);
      await fs.writeFile(abs, buf);
      const absMd = String(abs).replace(/\\/g, '/');
      dataMap.set(dataUrl, absMd);
    } catch (e) {
      logger.warn?.('image_draw:decode_base64_failed', { label: 'PLUGIN', error: String(e?.message || e) });
    }
  }

  return md.replace(re, (full, alt, url) => {
    const key = String(url || '').trim();
    if (map.has(key)) return `![${alt}](${map.get(key)})`;
    if (dataMap.has(key)) return `![${alt}](${dataMap.get(key)})`;
    return full;
  });
}

export default async function handler(args = {}, options = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return { success: false, code: 'INVALID', error: 'prompt is required', advice: buildAdvice('INVALID', { tool: 'image_draw' }) };

  const penv = options?.pluginEnv || {};
  const apiKey = penv.DRAW_API_KEY || process.env.DRAW_API_KEY || config.llm.apiKey;
  const baseURL = penv.DRAW_BASE_URL || process.env.DRAW_BASE_URL || config.llm.baseURL;
  const model = String(penv.DRAW_MODEL || process.env.DRAW_MODEL || config.llm.model || '').trim();
   const mode = String(penv.DRAW_MODE || process.env.DRAW_MODE || 'chat').toLowerCase();
   const imageSize = String(penv.DRAW_IMAGE_SIZE || process.env.DRAW_IMAGE_SIZE || '1024x1024');

  const oai = new OpenAI({ apiKey, baseURL });

  // 模式一：直接调用 /v1/images/generations
  if (mode === 'images') {
    try {
      const baseDir = 'artifacts';
      await fs.mkdir(baseDir, { recursive: true });

      const res = await oai.images.generate({
        model: model || undefined,
        prompt,
        n: 1,
        size: imageSize,
        response_format: 'b64_json'
      });

      const first = Array.isArray(res?.data) ? res.data[0] : null;
      const b64 = first?.b64_json;
      if (!b64) {
        return { success: false, code: 'NO_IMAGE', error: 'images API returned no image data', data: { prompt }, advice: buildAdvice('NO_IMAGE', { tool: 'image_draw', prompt }) };
      }

      const buf = Buffer.from(String(b64), 'base64');
      const name = `draw_${Date.now()}_0.png`;
      const abs = path.resolve(baseDir, name);
      await fs.writeFile(abs, buf);
      const absMd = String(abs).replace(/\\/g, '/');
      const content = formatLocalMarkdownImage(absMd);

      return { success: true, data: { prompt, content } };
    } catch (e) {
      logger.warn?.('image_draw:images_request_failed', { label: 'PLUGIN', error: String(e?.message || e) });
      const isTimeout = isTimeoutError(e);
      return { success: false, code: isTimeout ? 'TIMEOUT' : 'ERR', error: String(e?.message || e), advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'image_draw', prompt }) };
    }
  }

  // 模式二：chat.completions，流式接收 Markdown 图片链接（可能为 URL 或 base64）
  const system = '你是一个会画画的助手。请用自然的中文写 1-2 句简短描述，然后至少给出 1 个 Markdown 图片链接（例如：![image](...)）。不要使用代码块/代码围栏（不要输出 ``` ）。';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];

  try {
    const stream = await oai.chat.completions.create({ model, messages, stream: true });
    let content = '';
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || '';
      if (delta) {
        content += delta;
        if (typeof options?.onStream === 'function') {
          try {
            options.onStream({ type: 'delta', delta, content });
          } catch {}
        }
      }
    }

    if (!hasMarkdownImage(content)) {
      return { success: false, code: 'NO_MD_IMAGE', error: 'response has no markdown image', data: { prompt }, advice: buildAdvice('NO_MD_IMAGE', { tool: 'image_draw', prompt }) };
    }
    const rewritten = await downloadImagesAndRewrite(content, 'draw');
    const localMarkdown = await collectVerifiedLocalMarkdownImages(rewritten);
    if (!localMarkdown) {
      return { success: false, code: 'NO_LOCAL_IMAGE', error: 'unable to download image to local markdown', data: { prompt }, advice: buildAdvice('NO_LOCAL_IMAGE', { tool: 'image_draw', prompt }) };
    }
    return { success: true, data: { prompt, content: localMarkdown } };
  } catch (e) {
    logger.warn?.('image_draw:request_failed', { label: 'PLUGIN', error: String(e?.message || e) });
    const isTimeout = isTimeoutError(e);
    return { success: false, code: isTimeout ? 'TIMEOUT' : 'ERR', error: String(e?.message || e), advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'image_draw', prompt }) };
  }
}
