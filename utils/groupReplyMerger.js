import { getEnvBool, getEnvInt } from './envHotReloader.js';
import { createLogger } from './logger.js';

const logger = createLogger('GroupReplyMerger');

function getMergeConfig() {
  const enabled = getEnvBool('GROUP_MULTI_USER_MERGE_ENABLED', false);
  const windowMs = getEnvInt('GROUP_MULTI_USER_MERGE_WINDOW_MS', 5000);
  const maxUsers = getEnvInt('GROUP_MULTI_USER_MERGE_MAX_USERS', 2);
  return { enabled, windowMs, maxUsers };
}

const groupSessions = new Map(); // groupKey -> { windowStart, entries, timer }

function normalizeGroupId(groupId) {
  return String(groupId || '');
}

function buildMergedMessage(entries) {
  const primary = entries[0];
  const base = { ...(primary.msg || {}) };

  const mergedUsers = entries.map((item, index) => {
    const m = item.msg || {};
    const text =
      (typeof m.text === 'string' && m.text.trim()) ||
      (typeof m.summary === 'string' && m.summary.trim()) ||
      '';
    return {
      index,
      sender_id: m.sender_id != null ? String(m.sender_id) : '',
      sender_name: m.sender_name || '',
      message_id: m.message_id != null ? String(m.message_id) : '',
      text,
      time_str: m.time_str || '',
      raw: m
    };
  });

  base._merged = true;
  base._mergedUsers = mergedUsers;
  base._mergedPrimarySenderId = primary.senderId;
  base._mergedUserCount = mergedUsers.length;

  return base;
}

async function finalizeGroup(groupKey, deps) {
  const session = groupSessions.get(groupKey);
  if (!session) return;
  groupSessions.delete(groupKey);

  if (session.timer) {
    clearTimeout(session.timer);
  }

  const entries = Array.isArray(session.entries) ? session.entries : [];
  if (entries.length === 0) return;

  const { handleOneMessage, completeTask } = deps || {};
  if (typeof handleOneMessage !== 'function') {
    return;
  }

  const [primary, ...rest] = entries;
  const mergedMsg = entries.length === 1 ? primary.msg : buildMergedMessage(entries);

  try {
    await handleOneMessage(mergedMsg, primary.taskId);
  } catch (e) {
    logger.error('handleOneMessage in group merge failed', e);
  }

  if (Array.isArray(rest) && rest.length > 0 && typeof completeTask === 'function') {
    for (const item of rest) {
      try {
        const g = item && item.msg && item.msg.group_id != null ? String(item.msg.group_id) : '';
        const s = item && item.senderId != null ? String(item.senderId) : '';
        const convKey = g ? `group_${g}_sender_${s}` : `private_${s}`;
        await completeTask(convKey, item.taskId);
      } catch (e) {
        logger.debug('completeTask for merged sender failed', { err: String(e) });
      }
    }
  }
}

export async function handleGroupReplyCandidate(args, deps) {
  const { groupId, senderId, bundledMsg, taskId } = args || {};
  const { handleOneMessage } = deps || {};
  const groupKey = normalizeGroupId(groupId);

  if (!handleOneMessage || !groupKey || !bundledMsg || !taskId) {
    if (handleOneMessage && bundledMsg && taskId) {
      await handleOneMessage(bundledMsg, taskId);
    }
    return;
  }

  const { enabled, windowMs, maxUsers } = getMergeConfig();

  if (
    !enabled ||
    windowMs <= 0 ||
    maxUsers <= 1 ||
    bundledMsg.type !== 'group'
  ) {
    await handleOneMessage(bundledMsg, taskId);
    return;
  }

  let session = groupSessions.get(groupKey);
  const entry = { senderId: String(senderId ?? ''), msg: bundledMsg, taskId };

  if (!session) {
    session = {
      windowStart: Date.now(),
      entries: [entry],
      timer: null
    };
    groupSessions.set(groupKey, session);
    session.timer = setTimeout(() => {
      finalizeGroup(groupKey, deps).catch((e) => {
        logger.error('finalizeGroup timer error', e);
      });
    }, windowMs);
    return;
  }

  const existingIndex = session.entries.findIndex((it) => it.senderId === entry.senderId);
  if (existingIndex >= 0) {
    session.entries[existingIndex] = entry;
    return;
  }

  if (session.entries.length < maxUsers) {
    session.entries.push(entry);
    if (session.entries.length >= maxUsers) {
      await finalizeGroup(groupKey, deps);
    }
    return;
  }

  await finalizeGroup(groupKey, deps);

  const newSession = {
    windowStart: Date.now(),
    entries: [entry],
    timer: null
  };
  groupSessions.set(groupKey, newSession);
  newSession.timer = setTimeout(() => {
    finalizeGroup(groupKey, deps).catch((e) => {
      logger.error('finalizeGroup timer error', e);
    });
  }, windowMs);
}
