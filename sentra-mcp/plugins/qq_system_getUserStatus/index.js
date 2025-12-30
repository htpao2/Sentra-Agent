import wsCall from '../../src/utils/ws_rpc.js';

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
  const personaHint = '请结合你当前的预设/人设继续作答：当获取 QQ 在线状态失败时，要说明原因（参数/WS 连接/账号状态），给替代方案（补参数/稍后重试）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你查询某个 QQ 账号的在线状态，但需要提供 user_id（QQ号）。你把 QQ 号发我一下，我就继续查询。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 user_id（QQ号，数字）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试获取 QQ 在线状态，但 QQ 侧接口长时间没有响应（像是超时了）。你可以稍后再试，或检查一下 WS 服务是否正常。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS 服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试获取 QQ 在线状态，但这次失败了。可能是 WS 服务未连接、机器人无权限，或者目标账号状态异常。我可以帮你确认 QQ 号并稍后再查。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 user_id 是否正确',
      '确认 WS 服务在线后重试',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

export default async function handler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const url = String(penv.WS_SDK_URL || 'ws://localhost:6702');
  const timeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || 15000));
  const path = 'system.getUserStatus';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  const user_id = Number(args.user_id);
  if (!Number.isFinite(user_id)) return { success: false, code: 'INVALID', error: 'user_id 不能为空', advice: buildAdvice('INVALID', { tool: 'qq_system_getUserStatus' }) };
  try {
    const resp = await wsCall({ url, path, args: [user_id], requestId, timeoutMs });
    return { success: true, data: { request: { type: 'sdk', path, args: [user_id], requestId }, response: resp } };
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return { success: false, code: isTimeout ? 'TIMEOUT' : 'ERR', error: String(e?.message || e), advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_system_getUserStatus', user_id }) };
  }
}
