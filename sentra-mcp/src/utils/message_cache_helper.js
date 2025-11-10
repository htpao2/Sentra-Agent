/**
 * 消息缓存辅助工具
 * 用于插件从缓存中获取 user_id 和 group_id
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../logger/index.js';

// 缓存目录路径（项目根目录下的 cache/messages）
const CACHE_DIR = path.resolve(process.cwd(), 'cache', 'messages');

/**
 * 从缓存中读取消息信息
 * @param {string} runId - 运行ID
 * @returns {Promise<Object|null>} 缓存数据或 null
 */
async function loadMessageCache(runId) {
  if (!runId) {
    return null;
  }

  try {
    const cacheFilePath = path.join(CACHE_DIR, `${runId}.json`);
    const data = await fs.readFile(cacheFilePath, 'utf-8');
    const cacheData = JSON.parse(data);
    return cacheData;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn?.('message_cache_helper:load_failed', { 
        label: 'UTIL', 
        runId, 
        error: String(error.message) 
      });
    }
    return null;
  }
}

/**
 * 从缓存或参数中获取 user_id 和 group_id
 * @param {Object} args - 插件参数
 * @param {Object} options - 插件选项
 * @param {string} pluginName - 插件名称（用于日志）
 * @returns {Promise<Object>} { user_id, group_id, source }
 */
export async function getIdsWithCache(args = {}, options = {}, pluginName = 'unknown') {
  let user_id = args.user_id;
  let group_id = args.group_id;
  let source = 'params'; // 来源：'params' | 'cache' | 'none'

  // 如果参数中已经提供了 ID
  if (user_id || group_id) {
    // 如果同时提供，优先使用 group_id
    if (user_id && group_id) {
      logger.info?.(`${pluginName}:both_ids_provided`, { 
        label: 'PLUGIN', 
        action: 'prioritize_group_id' 
      });
      user_id = undefined;
    }
    
    logger.debug?.(`${pluginName}:ids_from_params`, { 
      label: 'PLUGIN', 
      user_id, 
      group_id 
    });
    
    return { user_id, group_id, source };
  }

  // 如果参数中没有提供 ID，尝试从缓存读取
  const runId = options?.runId || options?.context?.runId;
  
  if (!runId) {
    logger.debug?.(`${pluginName}:no_runid`, { 
      label: 'PLUGIN', 
      message: '未提供 runId，无法从缓存读取' 
    });
    return { user_id: undefined, group_id: undefined, source: 'none' };
  }

  try {
    const cache = await loadMessageCache(runId);
    
    if (!cache || !cache.message) {
      logger.debug?.(`${pluginName}:cache_not_found`, { 
        label: 'PLUGIN', 
        runId 
      });
      return { user_id: undefined, group_id: undefined, source: 'none' };
    }

    const msg = cache.message;
    
    // 从缓存中提取 ID
    if (msg.type === 'group' && msg.group_id) {
      group_id = String(msg.group_id);
      source = 'cache';
    } else if (msg.type === 'private' && msg.sender_id) {
      user_id = String(msg.sender_id);
      source = 'cache';
    }

    logger.info?.(`${pluginName}:ids_from_cache`, { 
      label: 'PLUGIN', 
      runId,
      user_id, 
      group_id,
      messageType: msg.type
    });

    return { user_id, group_id, source };
  } catch (error) {
    logger.error?.(`${pluginName}:cache_load_error`, { 
      label: 'PLUGIN', 
      runId,
      error: String(error.message) 
    });
    return { user_id: undefined, group_id: undefined, source: 'none' };
  }
}

export default {
  getIdsWithCache
};
