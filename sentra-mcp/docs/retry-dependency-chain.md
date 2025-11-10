# 重试机制：依赖链智能重试优化

## 问题背景

用户发现重试机制没有考虑依赖关系，导致：
1. **下游依赖未重试**：失败步骤的依赖步骤不会被重试
2. **资源浪费**：上游失败后仍然重试下游步骤
3. **逻辑不完整**：依赖链断裂，无法完整恢复

### 问题场景示例

```javascript
// Plan:
步骤 0: list_files → 成功 ✅
步骤 1: read_file (dependsOn: [0]) → 失败 ❌
步骤 2: process_data (dependsOn: [1]) → 失败/跳过 ❌ (因为步骤1失败)
步骤 3: write_result (dependsOn: [2]) → 失败/跳过 ❌ (因为步骤2失败)

// 旧版重试逻辑:
failedSteps = [1, 2, 3]
重试: 只执行步骤 1, 2, 3

// 问题:
1. 步骤 2 和 3 可能并发执行（不考虑依赖顺序）
2. 如果步骤 1 重试失败，步骤 2 和 3 仍会尝试（浪费资源）
3. 没有考虑依赖链的完整性
```

---

## 优化方案

### 1. 依赖链分析 ✅

新增 `buildDependencyChain()` 函数：

```javascript
/**
 * 构建依赖图：找出所有依赖某些步骤的下游步骤
 * @param {Array} steps - 计划步骤数组
 * @param {Array<number>} sourceIndices - 源步骤索引数组
 * @returns {Set<number>} 包含源步骤和所有下游依赖步骤的索引集合
 */
function buildDependencyChain(steps, sourceIndices) {
  const result = new Set(sourceIndices);
  const total = steps.length;
  
  // 递归查找下游依赖
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < total; i++) {
      if (result.has(i)) continue; // 已在结果集中
      
      const step = steps[i];
      const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
      
      // 如果该步骤依赖任何已在结果集中的步骤，则添加到结果集
      if (deps.some(d => result.has(d))) {
        result.add(i);
        changed = true;
      }
    }
  }
  
  return result;
}
```

**工作原理**：
1. 初始集合：包含所有失败步骤
2. 递归扩展：找出依赖集合中任意步骤的所有步骤
3. 持续迭代：直到没有新步骤加入

**示例**：
```javascript
failedIndices = [1]  // 步骤 1 失败
buildDependencyChain(steps, [1])
// → Set { 1, 2, 3 }  // 步骤 2 依赖 1，步骤 3 依赖 2
```

---

### 2. 智能跳过机制 ✅

在 `executePlan` 中添加上游失败检测：

```javascript
export async function executePlan(runId, objective, mcpcore, plan, opts = {}) {
  // ...
  
  // 重试模式下，跟踪已执行步骤的成功/失败状态
  const stepStatus = new Map(); // stepIndex -> { success: boolean, reason: string }
  
  const executeSingleStep = async (i) => {
    // ...
    
    // 重试模式下，检查依赖步骤是否失败
    if (retrySteps) {
      const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
      const failedDeps = deps.filter(d => {
        const status = stepStatus.get(Number(d));
        return status && !status.success;
      });
      
      if (failedDeps.length > 0) {
        // 依赖步骤失败，跳过此步骤以避免浪费
        const failedDepReasons = failedDeps.map(d => {
          const st = stepStatus.get(d);
          return `步骤${d}(${plan.steps[d]?.aiName}): ${st?.reason || '失败'}`;
        }).join('; ');
        
        const res = { 
          success: false, 
          code: 'SKIP_UPSTREAM_FAILED', 
          message: `跳过：上游依赖步骤失败 - ${failedDepReasons}` 
        };
        
        stepStatus.set(i, { success: false, reason: res.message });
        
        // 记录跳过事件
        emitToolResultGrouped({ type: 'tool_result', ... }, i);
        
        return { succeeded: 0, code: 'SKIP_UPSTREAM_FAILED' };
      }
    }
    
    // 正常执行步骤...
    
    // 重试模式下记录执行状态
    if (retrySteps) {
      stepStatus.set(i, { 
        success: res.success, 
        reason: res.success ? '成功' : (res.message || `失败: ${res.code}`) 
      });
    }
  };
}
```

**工作原理**：
1. **状态跟踪**：`stepStatus` Map 记录每个步骤的成功/失败状态
2. **上游检查**：执行前检查所有依赖步骤的状态
3. **智能跳过**：如果任何依赖失败，直接跳过并返回 `SKIP_UPSTREAM_FAILED`
4. **记录状态**：执行后更新状态，供下游步骤参考

---

### 3. 重试逻辑优化 ✅

修改 `planThenExecute` 和 `planThenExecuteStream` 中的重试逻辑：

```javascript
// 提取失败步骤的索引
const failedIndices = failedSteps.map((f) => Number(f.index)).sort((a, b) => a - b);

// ✅ 构建依赖链：找出所有依赖失败步骤的下游步骤
const retryChain = buildDependencyChain(plan.steps, failedIndices);
const retryIndices = Array.from(retryChain).sort((a, b) => a - b);

if (config.flags.enableVerboseSteps) {
  logger.info('开始重试失败步骤及其依赖链', {
    label: 'RETRY',
    originalFailed: failedIndices,  // [1]
    retryChain: retryIndices,       // [1, 2, 3]
    chainSize: retryIndices.length, // 3
    failedSteps: failedSteps.map((f) => `步骤${f.index}(${f.aiName}): ${f.reason}`)
  });
}

// ✅ 重试失败步骤及其所有下游依赖步骤
const retryExec = await executePlan(runId, objective, mcpcore, plan, { 
  retrySteps: retryIndices,  // 执行失败步骤 + 依赖它们的步骤
  seedRecent: prior, 
  conversation, 
  context 
});
```

---

## 完整工作流程

### 修复后的重试流程 ✅

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 第一次执行                                                 │
│    步骤 0: list_files → 成功 ✅                               │
│    步骤 1: read_file → 失败 ❌ (文件不存在)                   │
│    步骤 2: process_data → 失败 ❌ (依赖步骤1)                 │
│    步骤 3: write_result → 失败 ❌ (依赖步骤2)                 │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Eval 评估                                                  │
│    failedSteps = [                                           │
│      { index: 1, aiName: 'read_file', reason: '文件不存在' }, │
│      { index: 2, aiName: 'process_data', reason: '...' },    │
│      { index: 3, aiName: 'write_result', reason: '...' }     │
│    ]                                                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. 构建依赖链 ✅                                              │
│    failedIndices = [1]  (只有步骤1是真正失败)                │
│    buildDependencyChain(steps, [1])                          │
│    → retryChain = Set { 1, 2, 3 }                            │
│    → retryIndices = [1, 2, 3]                                │
│                                                               │
│    原因: 步骤2 dependsOn [1], 步骤3 dependsOn [2]            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. 重试执行（按依赖顺序）✅                                   │
│    retrySteps = [1, 2, 3]                                    │
│    stepStatus = Map()  // 跟踪执行状态                        │
│                                                               │
│    执行步骤 1 (read_file):                                    │
│      → 检查依赖: 无依赖                                       │
│      → 执行: 失败 ❌ (文件仍不存在)                           │
│      → stepStatus.set(1, { success: false, reason: '...' })  │
│                                                               │
│    执行步骤 2 (process_data):                                 │
│      → 检查依赖: 步骤1                                        │
│      → stepStatus.get(1) = { success: false }                │
│      → ❌ 跳过: 上游依赖失败                                  │
│      → stepStatus.set(2, { success: false, reason: 'SKIP' }) │
│                                                               │
│    执行步骤 3 (write_result):                                 │
│      → 检查依赖: 步骤2                                        │
│      → stepStatus.get(2) = { success: false }                │
│      → ❌ 跳过: 上游依赖失败                                  │
│      → stepStatus.set(3, { success: false, reason: 'SKIP' }) │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. 重试结果                                                   │
│    retryExec = {                                             │
│      attempted: 3,  // 尝试了3个步骤                          │
│      succeeded: 0,  // 0个成功（步骤1失败，2和3被跳过）       │
│      used: [                                                  │
│        { aiName: 'read_file', success: false },              │
│        { aiName: 'process_data', code: 'SKIP_UPSTREAM_FAILED' }, │
│        { aiName: 'write_result', code: 'SKIP_UPSTREAM_FAILED' }  │
│      ]                                                        │
│    }                                                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 场景对比

### 场景 1: 上游失败 → 智能跳过下游 ✅

**执行计划**：
```javascript
步骤 0: api_auth → 成功 ✅
步骤 1: api_getData (dependsOn: [0]) → 失败 ❌ (API 超时)
步骤 2: processData (dependsOn: [1]) → 失败 ❌ (无数据)
步骤 3: saveResult (dependsOn: [2]) → 失败 ❌ (无数据)
```

**旧版重试** ❌：
```javascript
重试: [1, 2, 3]
执行步骤1 → 失败（仍超时）
执行步骤2 → 失败（浪费资源，无数据）
执行步骤3 → 失败（浪费资源，无数据）
结果: 3次失败，浪费时间和资源
```

**新版重试** ✅：
```javascript
重试: [1, 2, 3]
执行步骤1 → 失败（仍超时）→ stepStatus.set(1, { success: false })
执行步骤2 → 检查依赖 → 步骤1失败 → 跳过（SKIP_UPSTREAM_FAILED）
执行步骤3 → 检查依赖 → 步骤2失败 → 跳过（SKIP_UPSTREAM_FAILED）
结果: 1次真实失败，2次智能跳过，节省资源
```

---

### 场景 2: 上游成功 → 完整重试下游 ✅

**执行计划**：
```javascript
步骤 0: downloadFile → 失败 ❌ (网络错误)
步骤 1: parseFile (dependsOn: [0]) → 失败 ❌ (无文件)
步骤 2: generateReport (dependsOn: [1]) → 失败 ❌ (无数据)
```

**旧版重试** ❌：
```javascript
重试: [0, 1, 2]
执行步骤0 → 成功 ✅ (网络恢复)
执行步骤1 → ?（可能并发执行，看不到步骤0的新数据）
执行步骤2 → ?（可能并发执行，看不到步骤1的新数据）
结果: 不确定，依赖关系未保证
```

**新版重试** ✅：
```javascript
重试: [0, 1, 2]  // buildDependencyChain([0], steps) → [0, 1, 2]
执行步骤0 → 成功 ✅ → stepStatus.set(0, { success: true })
执行步骤1 → 检查依赖 → 步骤0成功 → 执行 → 成功 ✅
执行步骤2 → 检查依赖 → 步骤1成功 → 执行 → 成功 ✅
结果: 完整重试成功，依赖关系保证
```

---

### 场景 3: 部分成功 → 精确重试 ✅

**执行计划**：
```javascript
步骤 0: task_A → 成功 ✅
步骤 1: task_B → 失败 ❌
步骤 2: task_C (dependsOn: [0]) → 成功 ✅ (不依赖步骤1)
步骤 3: task_D (dependsOn: [1, 2]) → 失败 ❌ (依赖步骤1失败)
```

**旧版重试** ❌：
```javascript
重试: [1, 3]
执行步骤1 → 失败
执行步骤3 → 失败（浪费，步骤1仍失败）
结果: 2次失败
```

**新版重试** ✅：
```javascript
failedIndices = [1, 3]
buildDependencyChain([1, 3], steps) → [1, 3]（步骤3已在失败列表）
重试: [1, 3]

执行步骤1 → 失败 → stepStatus.set(1, { success: false })
执行步骤3 → 检查依赖 → 步骤1失败 → 跳过（SKIP_UPSTREAM_FAILED）
结果: 1次真实失败，1次智能跳过
```

---

## 新增功能

### 1. 依赖链分析函数

**位置**: `src/agent/planners.js` (L49-77)

```javascript
function buildDependencyChain(steps, sourceIndices)
```

**功能**: 递归查找所有下游依赖步骤

---

### 2. 步骤状态跟踪

**位置**: `src/agent/planners.js` (L460)

```javascript
const stepStatus = new Map(); // stepIndex -> { success: boolean, reason: string }
```

**功能**: 重试模式下跟踪每个步骤的成功/失败状态

---

### 3. 上游失败检测

**位置**: `src/agent/planners.js` (L623-681)

```javascript
// 重试模式下，检查依赖步骤是否失败
if (retrySteps) {
  const failedDeps = deps.filter(d => {
    const status = stepStatus.get(Number(d));
    return status && !status.success;
  });
  
  if (failedDeps.length > 0) {
    // 跳过此步骤
    return { code: 'SKIP_UPSTREAM_FAILED', succeeded: 0 };
  }
}
```

**功能**: 执行前检查依赖，如果上游失败则跳过

---

### 4. 新的错误码

**错误码**: `SKIP_UPSTREAM_FAILED`

**含义**: 因上游依赖步骤失败而跳过执行

**消息格式**:
```javascript
{
  success: false,
  code: 'SKIP_UPSTREAM_FAILED',
  message: '跳过：上游依赖步骤失败 - 步骤1(read_file): 文件不存在'
}
```

---

## 日志示例

### 修复前 ❌

```javascript
INFO  RETRY  开始重试失败步骤
{
  failedIndices: [1],
  failedSteps: ['步骤1(read_file): 文件不存在']
}

// 重试步骤1 → 失败
// 步骤2和3不会重试（即使它们依赖步骤1）
```

### 修复后 ✅

```javascript
INFO  RETRY  开始重试失败步骤及其依赖链
{
  originalFailed: [1],        // 原始失败步骤
  retryChain: [1, 2, 3],      // 包含依赖链的完整重试列表
  chainSize: 3,               // 重试步骤数量
  failedSteps: ['步骤1(read_file): 文件不存在']
}

INFO  STEP  跳过步骤（上游失败）
{
  stepIndex: 2,
  aiName: 'process_data',
  failedDeps: '步骤1(read_file): 文件不存在'
}

INFO  STEP  跳过步骤（上游失败）
{
  stepIndex: 3,
  aiName: 'write_result',
  failedDeps: '步骤2(process_data): 跳过：上游依赖步骤失败'
}
```

---

## 修改文件

1. **`src/agent/planners.js`**:
   - L49-77: 新增 `buildDependencyChain()` 函数
   - L460: 新增 `stepStatus` Map
   - L623-681: 新增上游失败检测逻辑
   - L933-938: 记录步骤执行状态
   - L1105-1107: 使用依赖链计算重试步骤
   - L1258-1260: Stream 模式同样使用依赖链

2. **`docs/retry-dependency-chain.md`** (本文档):
   - 完整的依赖链重试优化说明
   - 场景对比和示例

---

## 优势总结

### 1. 完整性 ✅
- 失败步骤的下游依赖会自动重试
- 依赖链完整，不遗漏

### 2. 高效性 ✅
- 上游失败时自动跳过下游
- 避免无意义的重试，节省资源

### 3. 准确性 ✅
- 按依赖顺序执行，保证数据流
- 状态跟踪清晰，日志详细

### 4. 可维护性 ✅
- 逻辑清晰，易于理解
- 错误信息详细，便于调试

---

## 注意事项

### 1. 依赖链计算

`buildDependencyChain` 会递归查找所有下游依赖：
- **直接依赖**: `step2.dependsOn = [1]`
- **间接依赖**: `step3.dependsOn = [2]`, `step2.dependsOn = [1]` → `step3` 也会被包含

### 2. 跳过 vs 失败

- **跳过** (`SKIP_UPSTREAM_FAILED`): 因上游失败而未执行
- **失败** (其他 code): 执行了但失败

两者都会记录在 `stepStatus` 中为 `success: false`，下游依赖会被跳过。

### 3. 并发执行

虽然使用了 `retrySteps`，但 `executePlan` 仍会按照依赖关系调度：
- 依赖未完成的步骤不会开始
- `isReady()` 函数会检查所有依赖是否 `finished`

### 4. 性能影响

- **依赖链计算**: O(n²) 最坏情况，但 n 通常很小（< 20 步骤）
- **状态检查**: O(1) Map 查找
- **总体**: 可忽略的性能开销

---

## 测试建议

### 测试场景 1: 线性依赖链

```javascript
步骤 0 → 步骤 1 → 步骤 2 → 步骤 3
```

测试:
- 步骤 1 失败 → 应重试 [1, 2, 3]
- 步骤 1 重试失败 → 步骤 2, 3 应跳过

---

### 测试场景 2: 分支依赖

```javascript
       ┌→ 步骤 1 → 步骤 3
步骤 0 ┤
       └→ 步骤 2 → 步骤 4
```

测试:
- 步骤 1 失败 → 应重试 [1, 3]，不影响 [2, 4]
- 步骤 0 失败 → 应重试 [0, 1, 2, 3, 4]

---

### 测试场景 3: 汇合依赖

```javascript
步骤 0 → 步骤 1 ┐
步骤 2 → 步骤 3 ┤→ 步骤 5
步骤 4 ────────┘
```

测试:
- 步骤 1 失败 → 应重试 [1, 5]
- 步骤 3 失败 → 应重试 [3, 5]
- 步骤 1 重试成功，步骤 3 重试失败 → 步骤 5 应跳过

---

## 相关文档

- `docs/retry-mechanism-fix.md` - 重试机制基础修复（Eval 混淆、exec 统计）
- `docs/optimization-summary.md` - 整体优化总结

---

## 更新日志

**2025-11-05**
- 新增 `buildDependencyChain()` 依赖链分析函数
- 新增 `stepStatus` Map 跟踪重试状态
- 新增上游失败检测和智能跳过逻辑
- 修改重试逻辑使用依赖链计算
- 新增 `SKIP_UPSTREAM_FAILED` 错误码

---

**优化完成！** 现在重试机制会智能处理依赖关系，避免无效重试，提高效率和准确性。🚀
