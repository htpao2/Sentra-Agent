import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('MessageCache');

const CACHE_DIR = path.resolve(process.cwd(), 'cache', 'messages');

/**
 * 确保缓存目录存在
 */
async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      logger.error('创建缓存目录失败', error);
    }
  }
}

/**
 * 保存消息缓存
 * @param {string} runId - 运行ID
 * @param {Object} messageInfo - 消息信息
 * @returns {Promise<boolean>} 是否保存成功
 */
export async function saveMessageCache(runId, messageInfo) {
  if (!runId || !messageInfo) {
    logger.warn('runId 或 messageInfo 为空，跳过保存');
    return false;
  }

  try {
    await ensureCacheDir();
    
    const cacheFilePath = path.join(CACHE_DIR, `${runId}.json`);
    
    // 构建缓存数据
    const cacheData = {
      runId,
      savedAt: new Date().toISOString(),
      savedTimestamp: Date.now(),
      message: {
        message_id: messageInfo.message_id,
        time: messageInfo.time,
        time_str: messageInfo.time_str,
        type: messageInfo.type,
        self_id: messageInfo.self_id,
        summary: messageInfo.summary,
        sender_id: messageInfo.sender_id,
        sender_name: messageInfo.sender_name,
        sender_card: messageInfo.sender_card,
        sender_role: messageInfo.sender_role,
        text: messageInfo.text,
        segments: messageInfo.segments,
        images: messageInfo.images || [],
        videos: messageInfo.videos || [],
        files: messageInfo.files || [],
        records: messageInfo.records || [],
        at_users: messageInfo.at_users || [],
        at_all: messageInfo.at_all || false,
        // 群聊信息
        group_id: messageInfo.group_id,
        group_name: messageInfo.group_name,
        // 私聊信息（如果是私聊，sender_id 就是 user_id）
        user_id: messageInfo.type === 'private' ? messageInfo.sender_id : undefined
      }
    };
    
    await fs.writeFile(cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf-8');
    logger.debug(`保存缓存: ${runId}.json`);
    return true;
  } catch (error) {
    logger.error('保存缓存失败', error);
    return false;
  }
}

/**
 * 读取消息缓存
 * @param {string} runId - 运行ID
 * @returns {Promise<Object|null>} 缓存数据，如果不存在或读取失败则返回 null
 */
export async function loadMessageCache(runId) {
  if (!runId) {
    logger.warn('runId 为空，无法读取缓存');
    return null;
  }

  try {
    const cacheFilePath = path.join(CACHE_DIR, `${runId}.json`);
    const data = await fs.readFile(cacheFilePath, 'utf-8');
    const cacheData = JSON.parse(data);
    logger.debug(`读取缓存: ${runId}.json`);
    return cacheData;
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.debug(`缓存文件不存在: ${runId}.json`);
    } else {
      logger.error('读取缓存失败', error);
    }
    return null;
  }
}

/**
 * 删除消息缓存
 * @param {string} runId - 运行ID
 * @returns {Promise<boolean>} 是否删除成功
 */
export async function deleteMessageCache(runId) {
  if (!runId) {
    return false;
  }

  try {
    const cacheFilePath = path.join(CACHE_DIR, `${runId}.json`);
    await fs.unlink(cacheFilePath);
    logger.debug(`删除缓存: ${runId}.json`);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('删除缓存失败', error);
    }
    return false;
  }
}

/**
 * 清理过期缓存（超过指定时间的缓存文件）
 * @param {number} maxAgeMs - 最大缓存时间（毫秒），默认 12 小时
 * @returns {Promise<number>} 删除的文件数量
 */
export async function cleanupExpiredCache(maxAgeMs = 12 * 60 * 60 * 1000) {
  try {
    await ensureCacheDir();
    
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();
    let deletedCount = 0;
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      const filePath = path.join(CACHE_DIR, file);
      try {
        const stats = await fs.stat(filePath);
        const fileAge = now - stats.mtimeMs;
        
        if (fileAge > maxAgeMs) {
          await fs.unlink(filePath);
          deletedCount++;
          logger.debug(`清理过期缓存: ${file}`);
        }
      } catch (error) {
        logger.error(`处理文件失败 ${file}`, error);
      }
    }
    
    if (deletedCount > 0) {
      logger.info(`清理完成，删除 ${deletedCount} 个过期缓存`);
    }
    
    return deletedCount;
  } catch (error) {
    logger.error('清理缓存失败', error);
    return 0;
  }
}

/**
 * 从缓存中提取 ID 信息
 * @param {string} runId - 运行ID
 * @returns {Promise<Object|null>} { user_id, group_id, type } 或 null
 */
export async function getIdsFromCache(runId) {
  const cache = await loadMessageCache(runId);
  if (!cache || !cache.message) {
    return null;
  }
  
  const msg = cache.message;
  return {
    user_id: msg.type === 'private' ? msg.sender_id : undefined,
    group_id: msg.type === 'group' ? msg.group_id : undefined,
    type: msg.type,
    sender_id: msg.sender_id,
    sender_name: msg.sender_name,
    group_name: msg.group_name
  };
}

/**
 * 列出所有缓存文件
 * @returns {Promise<Array<string>>} 缓存文件的 runId 列表
 */
export async function listCaches() {
  try {
    await ensureCacheDir();
    const files = await fs.readdir(CACHE_DIR);
    return files
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace('.json', ''));
  } catch (error) {
    logger.error('列出缓存失败', error);
    return [];
  }
}

/**
 * 获取缓存统计信息
 * @returns {Promise<Object>} 统计信息
 */
export async function getCacheStats() {
  try {
    await ensureCacheDir();
    const files = await fs.readdir(CACHE_DIR);
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    
    let totalSize = 0;
    for (const file of jsonFiles) {
      const filePath = path.join(CACHE_DIR, file);
      const stats = await fs.stat(filePath);
      totalSize += stats.size;
    }
    
    return {
      count: jsonFiles.length,
      totalSizeBytes: totalSize,
      totalSizeKB: (totalSize / 1024).toFixed(2),
      cacheDir: CACHE_DIR
    };
  } catch (error) {
    logger.error('获取统计信息失败', error);
    return {
      count: 0,
      totalSizeBytes: 0,
      totalSizeKB: '0',
      cacheDir: CACHE_DIR
    };
  }
}

// 导出默认对象
export default {
  saveMessageCache,
  loadMessageCache,
  deleteMessageCache,
  cleanupExpiredCache,
  getIdsFromCache,
  listCaches,
  getCacheStats
};
