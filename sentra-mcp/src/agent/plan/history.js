import { HistoryStore } from '../../history/store.js';
import { clip } from '../../utils/text.js';
import { formatSentraToolCall, formatSentraResult } from '../../utils/fc.js';

/**
 * 格式化 reason 数组为字符串（用于显示）
 * - 数组：用 '; ' 连接
 * - 其他：返回空字符串
 */
function formatReason(reason) {
  if (Array.isArray(reason) && reason.length > 0) {
    return reason.join('; ');
  }
  return '';
}

// 中文：构造“工具对话式上下文”，把所有已完成的步骤整理成一问一答：
// user: 现在该使用 <aiName> 了
// assistant: 参数(JSON): {...}\n结果(JSON): {...}

// 中文：返回可直接拼接到 user 消息末尾的依赖文本（而不是单独的 assistant 轮次），以保持 user/assistant 交替结构
/**
 * @param {Object} options
 * @param {string} options.runId - Run ID
 * @param {Array} options.dependsOn - Dependency indices
 * @param {boolean} options.useFC - Use Sentra XML format (FC mode)
 */
export async function buildDependentContextText(runId, dependsOn = [], useFC = false) {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) return '';
  try {
    const indices = Array.from(new Set(dependsOn.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0))).sort((a, b) => a - b);
    if (indices.length === 0) return '';
    const history = await HistoryStore.list(runId, 0, -1);
    const plan = await HistoryStore.getPlan(runId);
    const items = [];
    for (const idx of indices) {
      const h = history.find((x) => x.type === 'tool_result' && Number(x.plannedStepIndex) === idx);
      if (!h) continue;
      const r = (plan?.steps && plan.steps[Number(idx)]) ? plan.steps[Number(idx)].reason : '';
      items.push({
        plannedStepIndex: idx,
        aiName: h.aiName,
        reason: clip(r),
        argsPreview: clip(h.args),
        resultPreview: clip(h.result?.data ?? h.result),
      });
    }
    if (!items.length) return '';
    
    // FC 模式：使用 Sentra XML 格式（仅返回 XML，不附加中文标题或前缀）
    if (useFC) {
      const xmlResults = items.map(item => 
        formatSentraResult({
          stepIndex: item.plannedStepIndex,  // XML 中仍使用 step 属性
          aiName: item.aiName,
          reason: item.reason,
          args: item.argsPreview,
          result: { success: true, data: item.resultPreview }
        })
      ).join('\n\n');
      return `${xmlResults}`;
    }
    
    // 默认：JSON 格式
    return `\n依赖结果(JSON):\n${JSON.stringify(items, null, 2)}`;
  } catch {
    return '';
  }
}
/**
 * Build tool dialogue messages
 * @param {string} runId - Run ID
 * @param {number} upToStepIndex - Up to step index
 * @param {boolean} useFC - Use Sentra XML format (FC mode)
 * @param {boolean} includeCurrentStep - 重试模式：包含当前步骤的失败历史（默认 false）
 */
export async function buildToolDialogueMessages(runId, upToStepIndex, useFC = false, includeCurrentStep = false) {
  try {
    const history = await HistoryStore.list(runId, 0, -1);
    const plan = await HistoryStore.getPlan(runId);
    
    // 🔧 修复并发问题：只包含依赖链上的步骤，避免并发分支污染
    const currentStep = plan?.steps?.[upToStepIndex];
    const dependsOn = Array.isArray(currentStep?.dependsOn) ? currentStep.dependsOn : [];
    
    // 构建依赖链（包括间接依赖）
    const dependencyChain = new Set();
    const addDependencies = (stepIdx) => {
      if (dependencyChain.has(stepIdx)) return;
      dependencyChain.add(stepIdx);
      const step = plan?.steps?.[stepIdx];
      if (step && Array.isArray(step.dependsOn)) {
        step.dependsOn.forEach(dep => {
          const depNum = Number(dep);
          if (Number.isFinite(depNum) && depNum >= 0 && depNum < upToStepIndex) {
            addDependencies(depNum);
          }
        });
      }
    };
    dependsOn.forEach(dep => {
      const depNum = Number(dep);
      if (Number.isFinite(depNum) && depNum >= 0 && depNum < upToStepIndex) {
        addDependencies(depNum);
      }
    });
    
    // 只获取依赖链上的步骤历史
    // 重试模式下，includeCurrentStep=true 可以包含当前步骤的失败记录
    const prev = history
      .filter((h) => {
        if (h.type !== 'tool_result') return false;
        const idx = Number(h.plannedStepIndex);
        // 重试模式：包含当前步骤的历史（之前失败的尝试）
        if (includeCurrentStep && idx === upToStepIndex) return true;
        // 正常模式：只包含依赖链上的步骤
        return idx < upToStepIndex && dependencyChain.has(idx);
      })
      .sort((a, b) => (Number(a.plannedStepIndex) - Number(b.plannedStepIndex)));
    
    const msgs = [];
    for (const h of prev) {
      const aiName = h.aiName;
      const reasonRaw = plan?.steps?.[Number(h.plannedStepIndex)]?.reason;
      const reason = formatReason(reasonRaw);
      const plannedStepIndex = Number(h.plannedStepIndex);
      
      // FC 模式：使用 Sentra XML 格式（仅输出 XML，不再添加非 XML 的用户提示行）
      if (useFC) {
        // 工具调用 XML
        const toolCallXml = formatSentraToolCall(aiName, h.args);
        // 工具结果 XML
        const resultXml = formatSentraResult({
          stepIndex: plannedStepIndex,  // XML 中仍使用 step 属性
          aiName,
          reason: reasonRaw,
          args: h.args,
          result: h.result
        });
        msgs.push({ role: 'assistant', content: `${toolCallXml}\n\n${resultXml}` });
      } else {
        // 默认：JSON 格式
        const argsPreview = clip(h.args);
        const resultPreview = clip(h.result?.data ?? h.result);
        msgs.push({ role: 'user', content: `现在该使用 ${aiName} 了。原因: ${reason || '(未提供)'}` });
        msgs.push({ role: 'assistant', content: [
          `参数(JSON): ${argsPreview}`,
          `结果(JSON): ${resultPreview}`
        ].join('\n') });
      }
    }
    return msgs;
  } catch (e) {
    // 不要中断主流程
    return [];
  }
}

// 中文：将 dependsOn 指定的上游步骤结果，整理为一个“依赖结果(JSON)”的 assistant 消息，便于参数生成阶段作为证据使用
export async function buildDependentContextMessages(runId, dependsOn = []) {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) return [];
  try {
    const indices = Array.from(new Set(dependsOn.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0))).sort((a, b) => a - b);
    if (indices.length === 0) return [];
    const history = await HistoryStore.list(runId, 0, -1);
    const items = [];
    for (const idx of indices) {
      const h = history.find((x) => x.type === 'tool_result' && Number(x.plannedStepIndex) === idx);
      if (!h) continue;
      items.push({
        plannedStepIndex: idx,
        aiName: h.aiName,
        argsPreview: clip(h.args),
        resultPreview: clip(h.result?.data ?? h.result),
      });
    }
    if (!items.length) return [];
    const content = `依赖结果(JSON):\n${JSON.stringify(items, null, 2)}`;
    return [{ role: 'assistant', content }];
  } catch {
    return [];
  }
}

export default { buildToolDialogueMessages };
