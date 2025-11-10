/**
 * Sentra协议处理模块
 * 包含<sentra-result>、<sentra-user-question>、<sentra-response>的构建和解析
 */

import { z } from 'zod';
import { jsonToXMLLines, extractXMLTag, extractAllXMLTags, extractFilesFromContent, valueToXMLString, USER_QUESTION_FILTER_KEYS } from './xmlUtils.js';
import { createLogger } from './logger.js';

const logger = createLogger('ProtocolUtils');

/**
 * 反转义 HTML 实体（处理模型可能输出的转义字符）
 * @param {string} text - 可能包含 HTML 实体的文本
 * @returns {string} 反转义后的文本
 */
function unescapeHTML(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Zod schema for resource validation
const ResourceSchema = z.object({
  type: z.enum(['image', 'video', 'audio', 'file', 'link']),
  source: z.string(),
  caption: z.string().optional()
});

const SentraResponseSchema = z.object({
  textSegments: z.array(z.string()),
  resources: z.array(ResourceSchema).optional().default([])
});

/**
 * 构建<sentra-result>块（工具执行结果）
 */
export function buildSentraResultBlock(ev) {
  const xmlLines = ['<sentra-result>'];
  
  // 递归遍历整个ev对象，自动生成XML
  xmlLines.push(...jsonToXMLLines(ev, 1, 0, 8));
  
  // 提取文件路径
  const files = extractFilesFromContent(ev);
  if (files.length > 0) {
    xmlLines.push('  <extracted_files>');
    files.forEach(f => {
      xmlLines.push('    <file>');
      xmlLines.push(`      <key>${f.key}</key>`);
      xmlLines.push(`      <path>${valueToXMLString(f.path, 0)}</path>`);
      xmlLines.push('    </file>');
    });
    xmlLines.push('  </extracted_files>');
  }
  
  xmlLines.push('</sentra-result>');
  return xmlLines.join('\n');
}

/**
 * 构建<sentra-user-question>块（用户提问）
 * 自动过滤segments、images、videos、files、records等冗余字段
 */
export function buildSentraUserQuestionBlock(msg) {
  const xmlLines = ['<sentra-user-question>'];
  
  // 递归遍历msg对象，过滤指定的键
  xmlLines.push(...jsonToXMLLines(msg, 1, 0, 6, USER_QUESTION_FILTER_KEYS));
  
  xmlLines.push('</sentra-user-question>');
  return xmlLines.join('\n');
}

/**
 * 解析<sentra-response>协议
 */
export function parseSentraResponse(response) {
  const responseContent = extractXMLTag(response, 'sentra-response');
  if (!responseContent) {
    logger.warn('未找到 <sentra-response> 块，返回原文');
    return { textSegments: [response], resources: [] };
  }
  
  // 提取所有 <text1>, <text2>, <text3> ... 标签
  const textSegments = [];
  let index = 1;
  while (true) {
    const textTag = `text${index}`;
    const textContent = extractXMLTag(responseContent, textTag);
    if (!textContent) break;
    
    // 反转义 HTML 实体（处理模型可能输出的转义字符）
    const unescapedText = unescapeHTML(textContent.trim());
    textSegments.push(unescapedText);
    //logger.debug(`提取 <${textTag}>: ${unescapedText.slice(0, 80)}`);
    index++;
  }
  
  // 如果没有文本，直接跳过（保持空数组）
  if (textSegments.length === 0) {
    logger.warn('未找到任何文本段落，保持空数组');
  }
  
  logger.debug(`共提取 ${textSegments.length} 个文本段落`);
  
  // 提取 <resources> 块
  const resourcesBlock = extractXMLTag(responseContent, 'resources');
  let resources = [];
  
  if (resourcesBlock && resourcesBlock.trim()) {
    const resourceTags = extractAllXMLTags(resourcesBlock, 'resource');
    logger.debug(`找到 ${resourceTags.length} 个 <resource> 标签`);
    
    resources = resourceTags
      .map((resourceXML, idx) => {
        try {
          const type = extractXMLTag(resourceXML, 'type');
          const source = extractXMLTag(resourceXML, 'source');
          const caption = extractXMLTag(resourceXML, 'caption');
          
          if (!type || !source) {
            logger.warn(`resource[${idx}] 缺少必需字段`);
            return null;
          }
          
          const resource = { type, source };
          if (caption) resource.caption = caption;
          
          return ResourceSchema.parse(resource);
        } catch (e) {
          logger.warn(`resource[${idx}] 解析或验证失败: ${e.message}`);
          return null;
        }
      })
      .filter(Boolean);
    
    logger.success(`成功解析并验证 ${resources.length} 个 resources`);
  } else {
    logger.debug('无 <resources> 块或为空');
  }
  
  // 提取 <emoji> 标签（可选，最多一个）
  const emojiBlock = extractXMLTag(responseContent, 'emoji');
  let emoji = null;
  
  if (emojiBlock && emojiBlock.trim()) {
    try {
      const source = extractXMLTag(emojiBlock, 'source');
      const caption = extractXMLTag(emojiBlock, 'caption');
      
      if (source) {
        emoji = { source };
        if (caption) emoji.caption = caption;
        logger.debug(`找到 <emoji> 标签: ${source.slice(0, 60)}`);
      } else {
        logger.warn('<emoji> 标签缺少 <source> 字段');
      }
    } catch (e) {
      logger.warn(`<emoji> 解析失败: ${e.message}`);
    }
  }
  
  // 最终验证整体结构
  try {
    const validated = SentraResponseSchema.parse({ textSegments, resources });
    //logger.success('协议验证通过');
    //logger.debug(`textSegments: ${validated.textSegments.length} 段`);
    //logger.debug(`resources: ${validated.resources.length} 个`);
    if (emoji) {
      //logger.debug(`emoji: ${emoji.source}`);
      validated.emoji = emoji;  // 添加 emoji 到返回结果
    }
    return validated;
  } catch (e) {
    logger.error('协议验证失败', e.errors);
    const fallback = { textSegments: textSegments.length > 0 ? textSegments : [response], resources: [] };
    if (emoji) fallback.emoji = emoji;  // 即使验证失败也保留 emoji
    return fallback;
  }
}
