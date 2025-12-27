export default async function handler(args = {}) {
  const userId = typeof args.user_id === 'string' ? args.user_id.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  const mediaHints = Array.isArray(args.media_hints) ? args.media_hints : undefined;

  if (!userId) {
    return { success: false, code: 'INVALID', error: 'user_id 是必须的字符串参数' };
  }
  if (!/^\d+$/.test(userId)) {
    return { success: false, code: 'INVALID', error: 'user_id 必须为纯数字字符串' };
  }
  if (!content) {
    return { success: false, code: 'INVALID', error: 'content 不能为空' };
  }

  return {
    success: true,
    data: {
      action: 'send_private_message',
      target: { type: 'private', id: userId },
      content,
      media_hints: mediaHints,
      note: 'This tool is for confirming the target and intent. Produce the final message text yourself. If you need cross-chat sending, set <user_id> in <sentra-response>.'
    }
  };
}
