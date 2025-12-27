export default async function handler(args = {}) {
  const groupId = typeof args.group_id === 'string' ? args.group_id.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  const mediaHints = Array.isArray(args.media_hints) ? args.media_hints : undefined;

  if (!groupId) {
    return { success: false, code: 'INVALID', error: 'group_id 是必须的字符串参数' };
  }
  if (!/^\d+$/.test(groupId)) {
    return { success: false, code: 'INVALID', error: 'group_id 必须为纯数字字符串' };
  }
  if (!content) {
    return { success: false, code: 'INVALID', error: 'content 不能为空' };
  }

  return {
    success: true,
    data: {
      action: 'send_group_message',
      target: { type: 'group', id: groupId },
      content,
      media_hints: mediaHints,
      note: 'This tool is for confirming the target and intent. Produce the final message text yourself. If you need cross-chat sending, set <group_id> in <sentra-response>.'
    }
  };
}
