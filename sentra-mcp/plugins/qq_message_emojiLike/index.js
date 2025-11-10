import wsCall from '../../src/utils/ws_rpc.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const faceMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'face-map.json'), 'utf-8'));

export default async function handler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const url = String(penv.WS_SDK_URL || 'ws://localhost:6702');
  const timeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || 15000));
  const sdkPath = 'message.emojiLike';
  const requestId = String(args.requestId || `${sdkPath}-${Date.now()}`);
  
  // 容错：自动转换 message_id 为字符串（AI 有时会传数字）
  const message_id = args.message_id != null ? String(args.message_id) : undefined;
  // 向后兼容：支持 emoji_id（单数）和 emoji_ids（复数）
  const emoji_ids_raw = args.emoji_ids !== undefined ? args.emoji_ids : args.emoji_id;
  
  // 参数校验
  if (!message_id) {
    return { success: false, code: 'INVALID', error: 'message_id 不能为空' };
  }
  // message_id 必须是纯数字字符串（如 "7379279827384728374"）
  if (!/^[0-9]+$/.test(String(message_id))) {
    return { 
      success: false, 
      code: 'INVALID_MESSAGE_ID', 
      error: `message_id 必须是纯数字字符串（如 "7379279827384728374"），当前值: "${message_id}"` 
    };
  }
  const messageIdNum = Number(message_id);
  if (!Number.isFinite(messageIdNum) || messageIdNum <= 0) {
    return { 
      success: false, 
      code: 'INVALID_MESSAGE_ID', 
      error: `message_id 无法转换为有效的正数: "${message_id}"` 
    };
  }
  
  // 规范化 emoji_ids 为数组（支持单个数字或数组）
  const emoji_ids = Array.isArray(emoji_ids_raw) ? emoji_ids_raw : [emoji_ids_raw];
  
  if (!emoji_ids.length) {
    return { success: false, code: 'INVALID', error: 'emoji_ids 不能为空' };
  }
  
  // 验证所有表情ID
  for (const id of emoji_ids) {
    if (!Number.isFinite(Number(id))) {
      return { success: false, code: 'INVALID', error: `emoji_id "${id}" 必须是有效的数字` };
    }
  }
  
  // 去重（避免重复贴同一个表情）
  const uniqueEmojiIds = [...new Set(emoji_ids.map(id => Number(id)))];
  
  // 循环调用 SDK 为每个表情贴上
  const results = [];
  const successList = [];
  const failedList = [];
  
  for (const emoji_id of uniqueEmojiIds) {
    const callArgs = [Number(message_id), Number(emoji_id)];
    const faceInfo = faceMap.faces[String(emoji_id)];
    const emojiName = faceInfo?.name || '未知表情';
    const emojiType = faceInfo?.type ? faceMap.types[String(faceInfo.type)] : '未知类型';
    
    const perRequestId = `${requestId}-${emoji_id}`;
    const sdkRequest = { type: 'sdk', path: sdkPath, args: callArgs, requestId: perRequestId };
    try {
      const resp = await wsCall({ url, path: sdkPath, args: callArgs, requestId: perRequestId, timeoutMs });
      successList.push({ emoji_id, emoji_name: emojiName, emoji_type: emojiType });
      results.push({ emoji_id, emoji_name: emojiName, success: true, sdk: { request: sdkRequest, response: resp } });
    } catch (err) {
      const errStr = String(err);
      failedList.push({ emoji_id, emoji_name: emojiName, error: errStr });
      results.push({ emoji_id, emoji_name: emojiName, success: false, error: errStr, sdk: { request: sdkRequest, error: errStr } });
    }
  }
  
  // 构建返回结果
  const totalCount = uniqueEmojiIds.length;
  const successCount = successList.length;
  const failedCount = failedList.length;
  
  if (successCount === totalCount) {
    // 全部成功
    const emojiNames = successList.map(e => `[${e.emoji_name}]`).join(' + ');
    return {
      success: true,
      message: `已给消息贴上 ${successCount} 个表情：${emojiNames}`,
      data: {
        summary: `实际行为：已成功给消息 ${message_id} 贴上 ${successCount} 个表情：${successList.map(e => `[${e.emoji_name}]（ID: ${e.emoji_id}，类型: ${e.emoji_type}）`).join('、')}`,
        message_id: String(message_id),
        total: totalCount,
        success_count: successCount,
        emojis: successList,
        sdk_calls: results
      },
      message_id: String(message_id),
      total: totalCount,
      success_count: successCount,
      emojis: successList,
      sdk_calls: results
    };
  } else if (successCount > 0) {
    // 部分成功
    const successNames = successList.map(e => `[${e.emoji_name}]`).join(' + ');
    const failedNames = failedList.map(e => `[${e.emoji_name}]`).join(' + ');
    return {
      success: true,
      code: 'PARTIAL_SUCCESS',
      message: `部分成功：已贴上 ${successCount} 个表情（${successNames}），${failedCount} 个失败（${failedNames}）`,
      data: {
        summary: `实际行为：给消息 ${message_id} 贴表情部分成功。成功 ${successCount} 个：${successList.map(e => `[${e.emoji_name}]（ID: ${e.emoji_id}）`).join('、')}；失败 ${failedCount} 个：${failedList.map(e => `[${e.emoji_name}]（原因: ${e.error}）`).join('、')}`,
        message_id: String(message_id),
        total: totalCount,
        success_count: successCount,
        failed_count: failedCount,
        emojis_success: successList,
        emojis_failed: failedList,
        sdk_calls: results
      },
      message_id: String(message_id),
      total: totalCount,
      success_count: successCount,
      failed_count: failedCount,
      emojis_success: successList,
      emojis_failed: failedList,
      sdk_calls: results
    };
  } else {
    // 全部失败
    const failedNames = failedList.map(e => `[${e.emoji_name}]`).join(' + ');
    return {
      success: false,
      code: 'ALL_FAILED',
      message: `全部失败：无法给消息贴上表情（${failedNames}）`,
      error: `所有表情贴加失败：${failedList.map(e => `[${e.emoji_name}]: ${e.error}`).join('；')}`,
      data: {
        summary: `实际行为：给消息 ${message_id} 贴表情失败。失败 ${failedCount} 个：${failedList.map(e => `[${e.emoji_name}]（原因: ${e.error}）`).join('、')}`,
        message_id: String(message_id),
        total: totalCount,
        failed_count: failedCount,
        emojis_failed: failedList,
        sdk_calls: results
      },
      message_id: String(message_id),
      total: totalCount,
      failed_count: failedCount,
      emojis_failed: failedList,
      sdk_calls: results
    };
  }
}
