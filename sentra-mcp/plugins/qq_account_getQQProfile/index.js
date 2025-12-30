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
  const personaHint = '请结合你当前的预设/人设继续作答：当查询 QQ 账号资料失败时，要说明原因（参数/网络/WS 连接），给替代方案（补参数/稍后重试/检查服务）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你查询 QQ 账号资料，但当前没有提供 user_id（QQ号）。你把 QQ 号发我一下，我就可以帮你查。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 user_id（QQ号，数字）',
        '如需强制刷新，可设置 refresh=true',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试查询 QQ 资料，但接口长时间没有响应（像是超时了）。你确认机器人与 WS 服务在线后，我们可以再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS_SDK_URL 对应服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试查询 QQ 资料，但这次执行失败了。可能是 WS 服务未连接、机器人离线或账号状态异常，我可以帮你排查后再试。\n\n（请结合你当前的预设/人设继续作答）',
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
  const path = 'user.info';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  const user_id = Number(args.user_id);
  if (!Number.isFinite(user_id)) return { success: false, code: 'INVALID', error: 'user_id 不能为空', advice: buildAdvice('INVALID', { tool: 'qq_account_getQQProfile' }) };
  const refresh = (typeof args.refresh === 'boolean') ? args.refresh : false;
  try {
    const resp = await wsCall({ url, path, args: [user_id, refresh], requestId, timeoutMs });
    return { success: true, data: { request: { type: 'sdk', path, args: [user_id, refresh], requestId }, response: resp } };
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return { success: false, code: isTimeout ? 'TIMEOUT' : 'ERR', error: String(e?.message || e), advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_account_getQQProfile', user_id, refresh }) };
  }
}
