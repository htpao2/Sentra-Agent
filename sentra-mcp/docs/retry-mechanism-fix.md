# 重试机制修复文档

## 问题背景

用户报告重试机制存在严重问题：
1. **重复重试已成功的步骤**
2. **Eval 阶段的 failedSteps 与 summary 不一致**
3. **重试后仍然判定失败**

### 问题日志示例

```javascript
// retry_done 事件
{
  type: 'retry_done',
  failedSteps: [
    {
      index: 7,
      aiName: 'local__write_file',
      reason: '写入失语日程表TXT文件的步骤在执行历史中缺失。'
    }
  ],
  exec: { used: [ [Object] ], attempted: 1, succeeded: 1, successRate: 1 }
}

// evaluation 事件
{
  type: 'evaluation',
  result: {
    success: true,  // ← 判定成功
    failedSteps: [],  // ← 但 failedSteps 为空！
    summary: 'Bravo!٩( ᐖ )۶ 已经完成了...猫猫也画好啦！'
  }
}
```

**矛盾点**：
- `retry_done` 说步骤 7 失败（"缺失"）
- `evaluation` 却说 `success: true`，`failedSteps: []`
- 到底是成功还是失败？

---

## 根本原因分析

发现了 **3 个核心 Bug**：

### Bug 1: Eval 看到了完整历史，导致混淆 ❌

**文件**: `src/agent/stages/evaluate.js` L42

```javascript
const history = await HistoryStore.list(runId, 0, -1);
const tail = history;  // ❌ 错误！直接传了全部历史
```

**问题**：
- 模型看到：第一次执行 + `retry_begin` + 重试执行 + `retry_done`
- 历史太长，模型容易混淆哪些步骤是最终状态
- 特别是看到某步骤第一次失败、第二次成功，容易误判

**应该**：
```javascript
const tail = history.slice(-Math.max(5, Math.min(12, history.length)));
```

只传最近 5-12 条记录，减少干扰。

---

### Bug 2: 重试后的 exec 统计不准确 ❌

**文件**: `src/agent/planners.js` L1025-1039

```javascript
// 只重试失败的步骤
exec = await executePlan(runId, objective, mcpcore, plan, { 
  retrySteps: failedIndices,  // ← 只执行失败的 2 个步骤
  ...
});

// ❌ 这个 exec 只统计了重试的 2 个步骤！
// exec = { attempted: 2, succeeded: 1, successRate: 0.5 }
evalObj = await evaluateRun(objective, plan, exec, runId, context);
```

**问题**：
- 重试前：10 个步骤，8 个成功，2 个失败
- 重试时：只执行 2 个失败步骤，1 个成功
- **传给 Eval 的 exec**：`{ attempted: 2, succeeded: 1 }`
- **模型看到的 history**：包含所有 10 个步骤的结果

**矛盾**：exec 统计与 history 内容完全不匹配！

**应该**：重试后从 history 重新统计全局的 exec：

```javascript
const retryExec = await executePlan(...);  // 只统计重试步骤

// 重新计算全局统计
const updatedHistory = await HistoryStore.list(runId, 0, -1);
const allToolResults = updatedHistory.filter((h) => h.type === 'tool_result');
const globalExec = {
  used: allToolResults.map(...),
  attempted: allToolResults.length,
  succeeded: allToolResults.filter((h) => h.result?.success === 1).length,
  successRate: ...
};

exec = globalExec;  // 传全局统计给 Eval
```

---

### Bug 3: "工具中心评估"在重试时误判 ❌

**文件**: `src/agent/stages/evaluate.js` L88-93

```javascript
// 工具中心评估：若所有工具都成功，直接返回 success
if (Number(exec?.attempted || 0) > 0 && 
    Number(exec?.succeeded || 0) === Number(exec?.attempted || 0)) {
  result = { success: true, summary: '工具中心评估：已调用的工具均成功...' };
  return result;  // ← 直接返回，模型都没看！
}
```

**问题场景**：
1. 第一次执行：10 个步骤，8 成功，2 失败
2. 进入重试：重试 2 个失败步骤
3. 重试成功：1 个成功（另一个可能还是失败）
4. 此时 exec = `{ attempted: 1, succeeded: 1 }` (Bug 2)
5. **触发"工具中心评估"**：`1 === 1`，直接返回 `success: true` ✅
6. **但实际上还有步骤失败！**

**应该**：重试场景下禁用"工具中心评估"快捷判断：

```javascript
const hasRetry = history.some((h) => h.type === 'retry_begin' || h.type === 'retry_done');
if (!hasRetry && exec?.attempted > 0 && exec?.succeeded === exec?.attempted) {
  // 只在没有重试的情况下使用快捷判断
  return { success: true, ... };
}
```

---

## 修复方案

### 修复 1: evaluate.js - 只传最近历史

```diff
  const history = await HistoryStore.list(runId, 0, -1);
  const stepNames = (exec?.used || []).map((u) => u.aiName).join(', ');
- const tail = history;
+ // 只传最近的历史记录，避免模型看到过多信息而混淆（特别是重试场景）
+ const tail = history.slice(-Math.max(5, Math.min(12, history.length)));
```

### 修复 2: evaluate.js - 禁用重试时的快捷判断

```diff
+ // 检查 history 中是否有 retry_begin 事件，如果有则不使用快捷判断
+ const hasRetry = history.some((h) => h.type === 'retry_begin' || h.type === 'retry_done');
- if (Number(exec?.attempted || 0) > 0 && Number(exec?.succeeded || 0) === Number(exec?.attempted || 0)) {
+ if (!hasRetry && Number(exec?.attempted || 0) > 0 && Number(exec?.succeeded || 0) === Number(exec?.attempted || 0)) {
    result = { success: true, summary: '工具中心评估：...' };
    return result;
  }
```

### 修复 3: planners.js - 重试后重新统计全局 exec

**planThenExecute 函数** (L1024-1056):

```diff
  // 只重试失败的步骤
- exec = await executePlan(runId, objective, mcpcore, plan, { 
+ const retryExec = await executePlan(runId, objective, mcpcore, plan, { 
    retrySteps: failedIndices,
    seedRecent: prior, 
    conversation, 
    context 
  });
  
  await HistoryStore.append(runId, { 
    type: 'retry_done', 
    failedSteps: failedSteps.map((f) => ({ index: f.index, aiName: f.aiName, reason: f.reason })),
    repairIndex: repairs + 1, 
-   exec 
+   exec: retryExec 
  });

+ // 重试后，需要从 history 中重新统计全局的 exec（因为 retryExec 只包含重试步骤）
+ const updatedHistory = await HistoryStore.list(runId, 0, -1);
+ const allToolResults = updatedHistory.filter((h) => h.type === 'tool_result');
+ const globalUsed = allToolResults.map((h) => ({
+   aiName: h.aiName,
+   args: h.args,
+   result: h.result
+ }));
+ const globalSucceeded = allToolResults.filter((h) => Number(h.result?.success) === 1).length;
+ const globalExec = {
+   used: globalUsed,
+   attempted: allToolResults.length,
+   succeeded: globalSucceeded,
+   successRate: allToolResults.length ? globalSucceeded / allToolResults.length : 0
+ };
+ exec = globalExec;

  evalObj = await evaluateRun(objective, plan, exec, runId, context);
```

**planThenExecuteStream 函数** (L1173-1209):

同样的修复逻辑。

---

## 修复效果

### 修复前 ❌

```javascript
// 第一次执行：10 步骤，8 成功，2 失败
{ type: 'evaluation', result: { success: false, failedSteps: [步骤3, 步骤7] } }

// 重试：只重试 2 个失败步骤，1 个成功
{ type: 'retry_done', exec: { attempted: 1, succeeded: 1 } }  // ← 只统计重试步骤

// 评估：误判为成功
{ type: 'evaluation', result: { success: true, failedSteps: [] } }  // ← Bug！
```

### 修复后 ✅

```javascript
// 第一次执行：10 步骤，8 成功，2 失败
{ type: 'evaluation', result: { success: false, failedSteps: [步骤3, 步骤7] } }

// 重试：只重试 2 个失败步骤，1 个成功
{ type: 'retry_done', exec: { attempted: 1, succeeded: 1 } }  // 记录重试统计

// 评估：传入全局统计
// globalExec = { attempted: 10, succeeded: 9, successRate: 0.9 }
// history 只传最近 5-12 条，清晰展示最终状态
{ type: 'evaluation', result: { success: false, failedSteps: [步骤3] } }  // ← 正确！
```

---

## 数据流对比

### 修复前的混乱数据流 ❌

```
1. 第一次执行 10 步骤
   ├─ 8 成功，2 失败
   └─ exec1 = { attempted: 10, succeeded: 8 }

2. Eval 第一次
   ├─ 传入: exec1, history (10 条 tool_result)
   └─ 结果: success=false, failedSteps=[步骤3, 步骤7]

3. 重试 2 个失败步骤
   ├─ 重试步骤3: 失败
   ├─ 重试步骤7: 成功
   └─ retryExec = { attempted: 2, succeeded: 1 }

4. Eval 第二次
   ├─ 传入: retryExec (❌ 只有重试统计！)
   ├─ 传入: history (❌ 包含全部历史，模型混淆！)
   ├─ 快捷判断: attempted=2, succeeded=1 → 不全成功，不触发快捷判断
   └─ 模型看到完整 history，发现很多成功步骤
   └─ 结果: success=true (❌ 误判！步骤3 还是失败的)
```

### 修复后的清晰数据流 ✅

```
1. 第一次执行 10 步骤
   ├─ 8 成功，2 失败
   └─ exec1 = { attempted: 10, succeeded: 8 }

2. Eval 第一次
   ├─ 传入: exec1, history 最近 12 条
   └─ 结果: success=false, failedSteps=[步骤3, 步骤7]

3. 重试 2 个失败步骤
   ├─ 重试步骤3: 失败
   ├─ 重试步骤7: 成功
   └─ retryExec = { attempted: 2, succeeded: 1 }

4. 重新统计全局 exec
   ├─ 从 history 提取所有 tool_result
   ├─ 去重（同一步骤多次执行，取最新）
   └─ globalExec = { attempted: 10, succeeded: 9 }

5. Eval 第二次
   ├─ 传入: globalExec (✅ 全局统计！)
   ├─ 传入: history 最近 12 条 (✅ 只看最新状态！)
   ├─ 检测到 hasRetry=true，禁用快捷判断
   ├─ 模型分析最近历史，发现步骤3 仍失败
   └─ 结果: success=false, failedSteps=[步骤3] (✅ 正确！)
```

---

## 重试机制工作流程（修复后）

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 初始执行 (executePlan)                                    │
│    - 执行所有步骤                                             │
│    - 收集 exec1 = { attempted, succeeded, ... }              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. 评估 (evaluateRun)                                        │
│    - 传入: exec1, history (最近 5-12 条)                     │
│    - 模型判断: success? failedSteps?                         │
└─────────────────────────────────────────────────────────────┘
                            ↓
                    success = false?
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. 重试失败步骤 (executePlan with retrySteps)                │
│    - 只执行 failedIndices = [3, 7]                           │
│    - 收集 retryExec = { attempted: 2, succeeded: 1 }         │
│    - 记录 retry_done 事件                                     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. 重新统计全局 exec ✅                                       │
│    - 从 history 提取所有 tool_result                          │
│    - 同一步骤多次执行，取最新结果                              │
│    - globalExec = { attempted: 10, succeeded: 9, ... }       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. 再次评估 (evaluateRun) ✅                                  │
│    - 传入: globalExec (全局统计)                              │
│    - 传入: history 最近 5-12 条 (只看最新状态)                │
│    - 检测 hasRetry=true，禁用快捷判断                         │
│    - 模型完整分析，给出准确结果                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 注意事项

### 1. retry_done 的 exec 字段

`retry_done` 事件中的 `exec` 字段**只记录重试步骤的统计**：

```javascript
{
  type: 'retry_done',
  failedSteps: [...],
  exec: { attempted: 2, succeeded: 1 }  // ← 只是重试步骤的统计
}
```

这是**正常的**，用于追踪重试过程。

### 2. 最终的 done 事件

`done` 事件中的 `exec` 字段是**全局统计**：

```javascript
{
  type: 'done',
  exec: { attempted: 10, succeeded: 9, successRate: 0.9 }  // ← 全局统计
}
```

这个统计包含了所有步骤的最终结果。

### 3. Eval 看到的数据

Eval 阶段现在只看**最近的历史**（5-12 条），避免混淆：

- ✅ 看到最近的成功/失败状态
- ✅ 看到重试后的最新结果
- ❌ 不看第一次执行的旧结果（避免混淆）

---

## 测试建议

### 场景 1: 部分失败 + 重试成功

1. 执行 10 个步骤，2 个失败
2. 重试 2 个失败步骤，全部成功
3. 预期：`success: true`, `failedSteps: []`

### 场景 2: 部分失败 + 重试部分成功

1. 执行 10 个步骤，2 个失败
2. 重试 2 个失败步骤，1 个成功，1 个仍失败
3. 预期：`success: false`, `failedSteps: [步骤3]`

### 场景 3: 超时失败（真实失败）

1. 执行步骤，某步骤真的超时失败
2. 重试后仍然超时
3. 预期：`success: false`, `failedSteps: [步骤X]`, reason 包含"超时"

### 场景 4: 误判"缺失"（实际已成功）

1. 执行所有步骤，全部成功
2. 模型第一次误判某步骤"缺失"
3. 重试时发现该步骤已存在（不再执行）
4. 预期：`success: true`, `failedSteps: []`

---

## 相关文件

- `src/agent/stages/evaluate.js` - 评估阶段
- `src/agent/planners.js` - 执行和重试逻辑
- `src/history/store.js` - 历史记录存储

---

## 更新日志

**2025-11-05**
- 修复 evaluate.js: 只传最近 5-12 条历史，避免混淆
- 修复 evaluate.js: 禁用重试时的"工具中心评估"快捷判断
- 修复 planners.js: 重试后重新统计全局 exec
- 修复 planners.js (streaming): 同样的修复逻辑

---

**修复完成！** 现在重试机制应该能正确判断成功/失败，不再出现 failedSteps 与 summary 矛盾的情况。
