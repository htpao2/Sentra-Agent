import { createLogger } from '../utils/logger.js';
import { getEnvInt } from '../utils/envHotReloader.js';

const logger = createLogger('DelayJobWorker');

export function createDelayJobRunJob(ctx) {
  const {
    HistoryStore,
    loadMessageCache,
    enqueueDelayedJob,
    sdk,
    historyManager,
    buildSentraResultBlock,
    buildSentraUserQuestionBlock,
    getDailyContextMemoryXml,
    personaManager,
    emo,
    buildSentraEmoSection,
    AGENT_PRESET_XML,
    baseSystem,
    CONTEXT_MEMORY_ENABLED,
    MAIN_AI_MODEL,
    triggerContextSummarizationIfNeeded,
    triggerPresetTeachingIfNeeded,
    chatWithRetry,
    smartSend,
    sendAndWaitResult,
    randomUUID,
    desireManager,
    getActiveTaskCount,
    enqueueProactiveCandidate
  } = ctx;

  function getPromiseConfig() {
    const privateMinSilentSecRaw = getEnvInt('PROMISE_PRIVATE_MIN_SILENT_SEC', 30);
    const groupMinSilentSecRaw = getEnvInt('PROMISE_GROUP_MIN_SILENT_SEC', 60);
    const rescheduleDelayMsRaw = getEnvInt('PROMISE_RESCHEDULE_DELAY_MS', 60000);
    const maxAttemptsRaw = getEnvInt('PROMISE_MAX_ATTEMPTS', 5);

    const privateMinSilentSec = Number.isFinite(privateMinSilentSecRaw)
      ? privateMinSilentSecRaw
      : 30;
    const groupMinSilentSec = Number.isFinite(groupMinSilentSecRaw)
      ? groupMinSilentSecRaw
      : 60;
    const rescheduleDelayMs = Number.isFinite(rescheduleDelayMsRaw)
      ? rescheduleDelayMsRaw
      : 60000;
    const maxAttempts = Number.isFinite(maxAttemptsRaw) ? maxAttemptsRaw : 5;

    return { privateMinSilentSec, groupMinSilentSec, rescheduleDelayMs, maxAttempts };
  }

  async function handlePromiseJob(job) {
    if (!job || job.aiName !== '__promise_fulfill__') return;

    const userId = job.userId ? String(job.userId) : '';
    const rawGroupId = job.groupId != null ? job.groupId : null;
    const groupId = rawGroupId != null ? String(rawGroupId) : null;
    const type = job.type === 'private' ? 'private' : groupId ? 'group' : 'private';
    const conversationKey = groupId ? `G:${groupId}` : userId ? `U:${userId}` : null;
    const objectiveRaw = typeof job.promiseObjective === 'string'
      ? job.promiseObjective
      : '';
    const objective = objectiveRaw.trim();

    if (!conversationKey || !userId || !objective) {
      logger.debug('DelayJobWorker: promise job 缺少必要字段，跳过', {
        jobId: job && job.jobId
      });
      return;
    }

    const { privateMinSilentSec, groupMinSilentSec, rescheduleDelayMs, maxAttempts } =
      getPromiseConfig();

    const attemptRaw = job.attempt;
    const attempt = Number.isFinite(attemptRaw) ? attemptRaw : 0;
    if (maxAttempts > 0 && attempt >= maxAttempts) {
      logger.info('DelayJobWorker: promise job 超过最大尝试次数，放弃', {
        jobId: job && job.jobId,
        attempt
      });
      return;
    }

    let engagement = null;
    if (desireManager && typeof desireManager.getUserEngagementSummary === 'function') {
      try {
        engagement = await desireManager.getUserEngagementSummary(conversationKey, userId);
      } catch (e) {
        logger.debug('DelayJobWorker: 获取用户参与度失败，将在后续重试', {
          jobId: job && job.jobId,
          err: String(e)
        });
      }
    }

    const activeCount =
      typeof getActiveTaskCount === 'function' && userId
        ? getActiveTaskCount(userId)
        : 0;

    let timeSinceLastUserSec = null;
    if (engagement && typeof engagement.timeSinceLastUserSec === 'number') {
      timeSinceLastUserSec = engagement.timeSinceLastUserSec;
    }

    const minSilentSec = type === 'private' ? privateMinSilentSec : groupMinSilentSec;
    const silentEnough =
      Number.isFinite(timeSinceLastUserSec) &&
      timeSinceLastUserSec >= Math.max(0, minSilentSec || 0);
    const noActiveTask = !Number.isFinite(activeCount) ? true : activeCount <= 0;

    if (!silentEnough || !noActiveTask) {
      if (typeof enqueueDelayedJob === 'function' && rescheduleDelayMs > 0) {
        const nextFireAt = Date.now() + Math.max(1000, rescheduleDelayMs);
        const nextJob = {
          ...job,
          jobId:
            job && job.jobId
              ? String(job.jobId) + '_retry_' + Date.now()
              : randomUUID(),
          fireAt: nextFireAt,
          attempt: attempt + 1
        };
        try {
          await enqueueDelayedJob(nextJob);
        } catch (e) {
          logger.warn('DelayJobWorker: 重新入队 promise job 失败', {
            jobId: job && job.jobId,
            err: String(e)
          });
        }
      }
      return;
    }

    if (typeof enqueueProactiveCandidate !== 'function') {
      logger.warn('DelayJobWorker: 缺少 enqueueProactiveCandidate，无法触发承诺补单', {
        jobId: job && job.jobId
      });
      return;
    }

    const baseMsg = job.lastMsg || {
      type,
      group_id: groupId,
      sender_id: userId,
      text: job.reason || objective,
      summary: job.reason || objective,
      message_id: null
    };

    const candidate = {
      conversationKey,
      chatType: type === 'private' ? 'private' : 'group',
      groupId: groupId,
      userId: userId,
      lastMsg: baseMsg,
      desireScore: 100,
      isFirstAfterUser: true,
      promiseObjective: objective
    };

    try {
      enqueueProactiveCandidate(candidate);
      logger.info('DelayJobWorker: 已触发承诺补单的主动候选', {
        jobId: job && job.jobId,
        conversationKey,
        userId,
        groupId
      });
    } catch (e) {
      logger.warn('DelayJobWorker: 触发承诺补单候选失败', {
        jobId: job && job.jobId,
        conversationKey,
        err: String(e)
      });
    }
  }

  async function buildDelaySystemContent(groupIdKey, senderId) {
    let personaXml = '';
    if (personaManager && senderId) {
      try {
        personaXml = personaManager.formatPersonaForContext(senderId);
      } catch {}
    }
    let emoXml = '';
    try {
      if (emo && senderId) {
        const ua = await emo.userAnalytics(senderId, { days: 7 });
        emoXml = buildSentraEmoSection(ua);
      }
    } catch {}
    let memoryXml = '';
    if (CONTEXT_MEMORY_ENABLED) {
      try {
        memoryXml = await getDailyContextMemoryXml(groupIdKey);
      } catch {}
    }
    const agentPresetXml = AGENT_PRESET_XML || '';
    const parts = [baseSystem, personaXml, emoXml, memoryXml, agentPresetXml].filter(Boolean);
    return parts.join('\n\n');
  }

  async function sendDelayedReply(baseMsg, reply, hasToolFlag = true) {
    if (!reply) return;
    try {
      if (typeof smartSend === 'function' && typeof sendAndWaitResult === 'function') {
        const allowReply = true;
        await smartSend(baseMsg, reply, sendAndWaitResult, allowReply, { hasTool: hasToolFlag });
      } else {
        logger.warn('DelayJobWorker: 缺少 smartSend/sendAndWaitResult，无法发送延迟任务回复', {
          type: baseMsg?.type,
          group_id: baseMsg?.group_id || null,
          sender_id: baseMsg?.sender_id || null
        });
      }
    } catch (e) {
      const gk = baseMsg?.group_id ? `G:${baseMsg.group_id}` : `U:${baseMsg?.sender_id || ''}`;
      logger.warn('DelayJobWorker: 发送延迟任务回复失败', { err: String(e), groupId: gk });
    }
  }

  return async function runJob(job) {
    try {
      const aiName = job && job.aiName;
      if (!aiName) {
        logger.warn('DelayJobWorker: job 缺少 aiName，跳过', { jobId: job && job.jobId });
        return;
      }

      if (aiName === '__promise_fulfill__') {
        await handlePromiseJob(job);
        return;
      }

      const runId = job && job.runId;
      const scheduleModeRaw = job && job.scheduleMode;
      const scheduleMode = typeof scheduleModeRaw === 'string'
        ? scheduleModeRaw
        : (job && job.schedule && job.schedule.mode) || undefined;
      const scheduleModeNorm = typeof scheduleMode === 'string' ? scheduleMode.toLowerCase() : '';
      const isImmediateSendOnly = scheduleModeNorm === 'immediate_exec';
      const plannedStepIndex = Number.isFinite(job && job.plannedStepIndex)
        ? Number(job.plannedStepIndex)
        : 0;

      let cacheMsg = null;
      if (runId) {
        try {
          const cache = await loadMessageCache(runId);
          cacheMsg = cache && cache.message ? cache.message : null;
        } catch (e) {
          logger.debug('DelayJobWorker: 读取消息缓存失败', { runId, err: String(e) });
        }
      }

      const fallbackSenderId = job && job.userId ? String(job.userId) : '';
      const baseMsg = cacheMsg || {
        type: (job && job.type) || 'private',
        group_id: job && job.groupId ? job.groupId : null,
        sender_id: fallbackSenderId,
        text: (job && job.reason) || '',
        summary: (job && job.reason) || '',
        message_id: null
      };

      const senderId = String(baseMsg.sender_id || fallbackSenderId || '');
      const groupIdKey = baseMsg.group_id ? `G:${baseMsg.group_id}` : `U:${senderId}`;
      const systemContent = await buildDelaySystemContent(groupIdKey, senderId);
      const contextXml = historyManager.getPendingMessagesContext(groupIdKey, senderId);
      const chatType = baseMsg.group_id ? 'group' : 'private';
      const userIdForMemory = senderId || '';

      if (isImmediateSendOnly && runId) {
        let history = [];
        try {
          history = await HistoryStore.list(runId, 0, -1);
        } catch (e) {
          logger.debug('DelayJobWorker: 读取 HistoryStore 失败', { runId, err: String(e) });
        }

        let toolEntry = null;
        if (Array.isArray(history) && history.length > 0) {
          const candidates = history.filter(
            (x) =>
              x &&
              x.type === 'tool_result' &&
              x.aiName === aiName &&
              Number(x.plannedStepIndex) === plannedStepIndex
          );
          if (candidates.length > 0) {
            candidates.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
            toolEntry = candidates[candidates.length - 1];
          }
        }

        if (!toolEntry) {
          const scheduleInfo = job && job.schedule ? job.schedule : {};
          const delayMs = Number.isFinite(job && job.delayMs)
            ? Number(job.delayMs)
            : Number(job && job.delayMs ? job.delayMs : 0) || 0;

          const progressEv = {
            type: 'tool_result',
            aiName: 'schedule_progress',
            plannedStepIndex,
            executionIndex: -1,
            reason:
              (job && job.reason)
                ? job.reason
                : (scheduleInfo && scheduleInfo.text)
                ? `正在执行定时任务 ${scheduleInfo.text}`
                : '定时任务仍在执行中',
            nextStep: '',
            args: {
              original_aiName: aiName,
              status: 'in_progress',
              elapsedMs: 0,
              delayMs,
              schedule: scheduleInfo
            },
            result: {
              success: true,
              code: 'IN_PROGRESS',
              provider: 'system',
              data: {
                original_aiName: aiName,
                kind: 'delay_progress',
                status: 'in_progress',
                delayMs,
                elapsedMs: 0,
                schedule_text: scheduleInfo && scheduleInfo.text,
                schedule_targetISO: scheduleInfo && scheduleInfo.targetISO,
                schedule_timezone: scheduleInfo && scheduleInfo.timezone
              }
            },
            elapsedMs: 0,
            dependsOn: [],
            dependedBy: [],
            groupId: null,
            groupSize: 1,
            toolMeta: { provider: 'system' }
          };

          let progressXml;
          try {
            progressXml = buildSentraResultBlock(progressEv);
          } catch (e) {
            logger.warn('DelayJobWorker: 构建进度 <sentra-result> 失败，回退 JSON', {
              err: String(e)
            });
            progressXml = JSON.stringify(progressEv);
          }

          const userQuestionXml = buildSentraUserQuestionBlock(baseMsg);
          const combinedUserQuestion = contextXml
            ? `${contextXml}\n\n${userQuestionXml}`
            : userQuestionXml;
          const fullUserContent = `${progressXml}\n\n${combinedUserQuestion}`;

          const conversations = [
            { role: 'system', content: systemContent },
            { role: 'user', content: fullUserContent }
          ];

          const progressPairId = await historyManager.startAssistantMessage(groupIdKey);

          const llmRes = await chatWithRetry(conversations, MAIN_AI_MODEL, groupIdKey);
          if (!llmRes || !llmRes.success) {
            logger.error('DelayJobWorker: AI 生成延迟进度回复失败', {
              groupId: groupIdKey,
              reason: llmRes && llmRes.reason,
              retries: llmRes && llmRes.retries
            });
            try {
              await historyManager.cancelConversationPairById(groupIdKey, progressPairId);
            } catch (e) {
              logger.debug('DelayJobWorker: 取消进度对话对失败', {
                groupId: groupIdKey,
                err: String(e)
              });
            }
          } else {
            const reply = llmRes.response || '';
            const noReply = !!llmRes.noReply;

            await historyManager.appendToAssistantMessage(
              groupIdKey,
              reply,
              progressPairId
            );

            const savedProgress = await historyManager.finishConversationPair(
              groupIdKey,
              progressPairId,
              fullUserContent
            );
            if (!savedProgress) {
              logger.warn(
                `保存进度对话对失败: ${groupIdKey} pairId ${String(progressPairId).substring(0, 8)}`
              );
            } else {
              triggerContextSummarizationIfNeeded({
                groupId: groupIdKey,
                chatType,
                userId: userIdForMemory
              }).catch((e) => {
                logger.debug(`ContextMemory: 异步摘要触发失败 ${groupIdKey}`, {
                  err: String(e)
                });
              });
              triggerPresetTeachingIfNeeded({
                groupId: groupIdKey,
                chatType,
                userId: userIdForMemory,
                userContent: fullUserContent,
                assistantContent: reply
              }).catch((e) => {
                logger.debug(`PresetTeaching: 异步教导触发失败 ${groupIdKey}`, {
                  err: String(e)
                });
              });
            }

            if (!noReply) {
              const allowReply = true;
              await sdk && sdk.sendAndWaitResult
                ? sdk.sendAndWaitResult(baseMsg, reply, allowReply, { hasTool: true })
                : null;
            } else {
              logger.info('DelayJobWorker: 模型选择对延迟进度保持沉默', { groupId: groupIdKey });
            }
          }

          const retryDelayMsBase =
            Number.isFinite(job && job.retryDelayMs) && Number(job.retryDelayMs) > 0
              ? Number(job.retryDelayMs)
              : 5000;
          const retryDelayMs = Math.max(1000, Math.min(retryDelayMsBase, 60000));
          const nextFireAt = Date.now() + retryDelayMs;

          const nextJob = {
            ...job,
            jobId: job && job.jobId ? String(job.jobId) + '_retry_' + Date.now() : randomUUID(),
            fireAt: nextFireAt
          };

          await enqueueDelayedJob(nextJob);
          return;
        }

        const ev = toolEntry;
        let resultXml;
        try {
          resultXml = buildSentraResultBlock(ev);
        } catch (e) {
          logger.warn('DelayJobWorker: 构建 <sentra-result> 失败，回退 JSON', { err: String(e) });
          resultXml = JSON.stringify(ev);
        }

        const userQuestionXml = buildSentraUserQuestionBlock(baseMsg);
        const combinedUserQuestion = contextXml
          ? `${contextXml}\n\n${userQuestionXml}`
          : userQuestionXml;
        const fullUserContent = `${resultXml}\n\n${combinedUserQuestion}`;

        const conversations = [
          { role: 'system', content: systemContent },
          { role: 'user', content: fullUserContent }
        ];

        const pairId = await historyManager.startAssistantMessage(groupIdKey);

        const llmRes = await chatWithRetry(conversations, MAIN_AI_MODEL, groupIdKey);
        if (!llmRes || !llmRes.success) {
          logger.error('DelayJobWorker: AI 生成延迟任务回复失败', {
            groupId: groupIdKey,
            reason: llmRes && llmRes.reason,
            retries: llmRes && llmRes.retries
          });
          try {
            await historyManager.cancelConversationPairById(groupIdKey, pairId);
          } catch (e) {
            logger.debug('DelayJobWorker: 取消延迟任务对话对失败', {
              groupId: groupIdKey,
              err: String(e)
            });
          }
          return;
        }

        const reply = llmRes.response || '';
        const noReply = !!llmRes.noReply;

        await historyManager.appendToAssistantMessage(groupIdKey, reply, pairId);

        const savedPair = await historyManager.finishConversationPair(
          groupIdKey,
          pairId,
          fullUserContent
        );
        if (!savedPair) {
          logger.warn(
            `保存延迟任务对话对失败: ${groupIdKey} pairId ${String(pairId).substring(0, 8)}`
          );
        } else {
          triggerContextSummarizationIfNeeded({
            groupId: groupIdKey,
            chatType,
            userId: userIdForMemory
          }).catch((e) => {
            logger.debug(`ContextMemory: 异步摘要触发失败 ${groupIdKey}`, {
              err: String(e)
            });
          });
          triggerPresetTeachingIfNeeded({
            groupId: groupIdKey,
            chatType,
            userId: userIdForMemory,
            userContent: fullUserContent,
            assistantContent: reply
          }).catch((e) => {
            logger.debug(`PresetTeaching: 异步教导触发失败 ${groupIdKey}`, {
              err: String(e)
            });
          });
        }

        if (noReply) {
          logger.info('DelayJobWorker: 模型选择对延迟任务保持沉默', { groupId: groupIdKey });
          return;
        }

        await sendDelayedReply(baseMsg, reply, true);
        return;
      }

      const toolArgs = job && job.args && typeof job.args === 'object' ? job.args : {};
      const startedAt = Date.now();
      let toolRes;
      try {
        const contextForTool = {
          source: 'delay_queue',
          runId: job && job.runId ? String(job.runId) : undefined,
        };
        toolRes = await sdk.callTool({ aiName, args: toolArgs, context: contextForTool });
      } catch (e) {
        toolRes = { success: false, code: 'ERROR', error: String(e), data: null };
      }
      const elapsedMs = Date.now() - startedAt;

      const ev = {
        type: 'tool_result',
        aiName,
        plannedStepIndex: 0,
        executionIndex: -1,
        reason: (job && job.reason) || '延迟任务到期自动执行',
        nextStep: '',
        args: toolArgs,
        result: toolRes,
        elapsedMs,
        dependsOn: [],
        dependedBy: [],
        groupId: null,
        groupSize: 1,
        toolMeta: { provider: (toolRes && toolRes.provider) || 'delay_queue' }
      };

      let resultXml;
      try {
        resultXml = buildSentraResultBlock(ev);
      } catch (e) {
        logger.warn('DelayJobWorker: 构建 <sentra-result> 失败，回退 JSON', { err: String(e) });
        resultXml = JSON.stringify(ev);
      }

      const userQuestionXml = buildSentraUserQuestionBlock(baseMsg);
      const combinedUserQuestion = contextXml
        ? `${contextXml}\n\n${userQuestionXml}`
        : userQuestionXml;
      const fullUserContent = `${resultXml}\n\n${combinedUserQuestion}`;

      const conversations = [
        { role: 'system', content: systemContent },
        { role: 'user', content: fullUserContent }
      ];

      const pairId = await historyManager.startAssistantMessage(groupIdKey);

      const llmRes = await chatWithRetry(conversations, MAIN_AI_MODEL, groupIdKey);
      if (!llmRes || !llmRes.success) {
        logger.error('DelayJobWorker: AI 生成延迟任务回复失败', {
          groupId: groupIdKey,
          reason: llmRes && llmRes.reason,
          retries: llmRes && llmRes.retries
        });
        try {
          await historyManager.cancelConversationPairById(groupIdKey, pairId);
        } catch (e) {
          logger.debug('DelayJobWorker: 取消延迟任务对话对失败', {
            groupId: groupIdKey,
            err: String(e)
          });
        }
        return;
      }

      const reply = llmRes.response || '';
      const noReply = !!llmRes.noReply;

      await historyManager.appendToAssistantMessage(groupIdKey, reply, pairId);

      const savedPair = await historyManager.finishConversationPair(
        groupIdKey,
        pairId,
        fullUserContent
      );
      if (!savedPair) {
        logger.warn(
          `保存延迟任务对话对失败: ${groupIdKey} pairId ${String(pairId).substring(0, 8)}`
        );
      } else {
        triggerContextSummarizationIfNeeded({
          groupId: groupIdKey,
          chatType,
          userId: userIdForMemory
        }).catch((e) => {
          logger.debug(`ContextMemory: 异步摘要触发失败 ${groupIdKey}`, {
            err: String(e)
          });
        });
        triggerPresetTeachingIfNeeded({
          groupId: groupIdKey,
          chatType,
          userId: userIdForMemory,
          userContent: fullUserContent,
          assistantContent: reply
        }).catch((e) => {
          logger.debug(`PresetTeaching: 异步教导触发失败 ${groupIdKey}`, {
            err: String(e)
          });
        });
      }

      if (noReply) {
        logger.info('DelayJobWorker: 模型选择对延迟任务保持沉默', { groupId: groupIdKey });
        return;
      }

      await sendDelayedReply(baseMsg, reply, true);
      return;
    } catch (e) {
      logger.warn('DelayJobWorker: 处理延迟任务异常', { err: String(e) });
    }
  };
}
