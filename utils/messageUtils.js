/**
 * 消息处理工具模块
 * 包含文本段落解析
 */

//import { createLogger } from './logger.js';

//const logger = createLogger('MessageUtils');

/**
 * 将文本段落数组转换为段落对象数组
 */
export function parseTextSegments(textSegments) {
  //logger.debug(`文本段落数: ${textSegments.length}`);
  
  const result = textSegments
    .filter(text => text && text.trim())
    .map((text, index) => {
      //logger.debug(`  段落${index + 1}: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);
      return { text: text.trim() };
    });
  
  //logger.debug(`最终段落数: ${result.length}`);
  return result;
}

/**
 * 构建单个段落的消息段
 */
export function buildSegmentMessage(segment) {
  const messageParts = [];
  
  if (segment.text) {
    messageParts.push({ type: 'text', data: { text: segment.text } });
  }
  
  return messageParts;
}
