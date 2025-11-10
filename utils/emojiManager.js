/**
 * Sentra Emoji Manager
 * 
 * 功能：
 * - 加载本地表情包配置
 * - 提供表情包路径映射
 * - 生成表情包使用说明
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const logger = createLogger('EmojiManager');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 表情包配置目录
const EMOJI_CONFIG_DIR = path.join(__dirname, 'emoji-stickers');
// 表情包图片目录
const EMOJI_DIR = path.join(EMOJI_CONFIG_DIR, 'emoji');
// 配置文件路径
const EMOJI_ENV_PATH = path.join(EMOJI_CONFIG_DIR, '.env');

/**
 * 表情包配置缓存
 */
let emojiConfig = null;
let lastLoadTime = 0;
const CACHE_TTL = 60000; // 缓存 60 秒

/**
 * 加载表情包配置
 * @returns {Object} 表情包配置对象 { filename: description }
 */
function loadEmojiConfig() {
  const now = Date.now();
  
  // 使用缓存
  if (emojiConfig && (now - lastLoadTime) < CACHE_TTL) {
    return emojiConfig;
  }

  const config = {};

  try {
    // 检查 .env 文件是否存在
    if (!fs.existsSync(EMOJI_ENV_PATH)) {
      logger.warn('.env file not found:', EMOJI_ENV_PATH);
      return {};
    }

    // 读取 .env 文件
    const envContent = fs.readFileSync(EMOJI_ENV_PATH, 'utf-8');
    const lines = envContent.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // 解析 KEY=VALUE 格式
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex === -1) {
        continue;
      }

      const key = trimmed.substring(0, equalIndex).trim();
      const value = trimmed.substring(equalIndex + 1).trim();

      // 移除引号
      const cleanValue = value.replace(/^["']|["']$/g, '');

      if (key && cleanValue) {
        config[key] = cleanValue;
      }
    }

    emojiConfig = config;
    lastLoadTime = now;

    logger.info(`Loaded ${Object.keys(config).length} emoji configs`);
    return config;

  } catch (error) {
    logger.error('Failed to load emoji config', error);
    return {};
  }
}

/**
 * 获取表情包的绝对路径
 * @param {string} filename - 表情包文件名
 * @returns {string|null} 绝对路径，如果文件不存在则返回 null
 */
export function getEmojiPath(filename) {
  if (!filename) return null;

  const fullPath = path.join(EMOJI_DIR, filename);

  // 检查文件是否存在
  if (!fs.existsSync(fullPath)) {
    logger.warn(`Emoji file not found: ${filename}`);
    return null;
  }

  return path.resolve(fullPath);
}

/**
 * 获取所有可用的表情包列表
 * @returns {Array<{filename: string, description: string, path: string}>}
 */
export function getAvailableEmojis() {
  const config = loadEmojiConfig();
  const emojis = [];

  for (const [filename, description] of Object.entries(config)) {
    const fullPath = getEmojiPath(filename);
    if (fullPath) {
      emojis.push({
        filename,
        description,
        path: fullPath
      });
    }
  }

  return emojis;
}

/**
 * 生成表情包使用说明（用于 AI 提示词）
 * @returns {string} Markdown 格式的表情包说明
 */
export function generateEmojiPrompt() {
  const config = loadEmojiConfig();
  const entries = Object.entries(config);

  if (entries.length === 0) {
    return '(No emoji stickers configured)';
  }

  let prompt = '\n';
  prompt += '| Absolute Path | Description | Usage Scenario |\n';
  prompt += '|---------------|-------------|----------------|\n';

  for (const [filename, description] of entries) {
    // 获取绝对路径并检查文件是否存在
    const fullPath = getEmojiPath(filename);
    if (fullPath) {
      // 输出完整的绝对路径，AI 可以直接使用
      prompt += `| \`${fullPath}\` | ${description} | Use when context matches |\n`;
    }
  }

  prompt += '\n**IMPORTANT**: Use the EXACT absolute path from the table above. Do NOT use placeholder paths like `/absolute/path/to/...`';

  return prompt;
}

/**
 * 生成 Markdown 预览（用于文档）
 * @returns {string} Markdown 格式的表情包预览
 */
export function generateEmojiMarkdown() {
  const config = loadEmojiConfig();
  const entries = Object.entries(config);

  if (entries.length === 0) {
    return '(No emoji stickers configured)';
  }

  let markdown = '# Sentra Emoji Stickers\n\n';

  for (const [filename, description] of entries) {
    const fullPath = path.join(EMOJI_DIR, filename);
    const exists = fs.existsSync(fullPath);
    
    if (exists) {
      markdown += `## ${filename}\n\n`;
      markdown += `**Description**: ${description}\n\n`;
      markdown += `![${description}](${filename})\n\n`;
      markdown += '---\n\n';
    }
  }

  return markdown;
}

/**
 * 验证表情包文件名是否有效
 * @param {string} filename - 表情包文件名
 * @returns {boolean}
 */
export function isValidEmoji(filename) {
  if (!filename || typeof filename !== 'string') {
    return false;
  }

  const config = loadEmojiConfig();
  return filename in config && fs.existsSync(path.join(EMOJI_DIR, filename));
}

/**
 * 获取表情包目录路径
 * @returns {string}
 */
export function getEmojiDirectory() {
  return EMOJI_DIR;
}

/**
 * 重新加载表情包配置（清除缓存）
 */
export function reloadEmojiConfig() {
  emojiConfig = null;
  lastLoadTime = 0;
  return loadEmojiConfig();
}

// 默认导出
export default {
  getEmojiPath,
  getAvailableEmojis,
  generateEmojiPrompt,
  generateEmojiMarkdown,
  isValidEmoji,
  getEmojiDirectory,
  reloadEmojiConfig
};
