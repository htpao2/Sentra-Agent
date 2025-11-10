# Reflection 机制：任务完整性检查与自动补充

## 概述

**Reflection（反思）机制** 是基于 LLM Agent 最佳实践的全局任务完整性检查系统，在任务总结前自动检测遗漏的操作，并智能生成补充计划以完善任务执行。

### 核心特性

- **Global Reflection**：分析整个任务执行历史，而非单个步骤
- **Goal-Driven**：基于任务目标判断完整性，避免盲目增加步骤
- **Adaptive**：根据上下文动态调整判断标准，防止过度或不足补充
- **Context-Aware**：补充计划继承之前的工具上下文和执行历史

## 工作流程

```
┌─────────────┐
│ 任务执行完成 │
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│ Reflection 阶段     │
│ (checkTaskCompleteness) │
└──────┬──────────────┘
       │
       ├─ 完整 ──────────┐
       │                  │
       ├─ 不完整 ─────►  │
       │   ▼              │
       │ ┌─────────────┐ │
       │ │ 生成补充计划│ │
       │ └──────┬──────┘ │
       │        │         │
       │        ▼         │
       │ ┌─────────────┐ │
       │ │ 执行补充步骤│ │
       │ └──────┬──────┘ │
       │        │         │
       │        ▼         │
       │ ┌─────────────┐ │
       │ │ 更新统计信息│ │
       │ └──────┬──────┘ │
       │        │         │
       └────────┴─────────┘
                │
                ▼
       ┌─────────────┐
       │   总结阶段   │
       └─────────────┘
```

## 判断标准

### ✅ 任务完整（is_complete = true）

以下情况判定为任务已完整：

1. **目标充分达成**：任务目标已充分实现
2. **操作已覆盖**：所有必要的操作都已执行
3. **无明显遗漏**：没有明显遗漏的关键步骤
4. **边际效益低**：进一步补充不会显著提升任务质量

**示例**：
- 用户要求"生成两张插画"，已成功生成两张图片 → 完整
- 用户要求"搜索信息"，已成功搜索并获取结果 → 完整
- 用户要求"读取文件"，已成功读取文件内容 → 完整

### ❌ 任务不完整（is_complete = false）

以下情况判定为任务不完整：

1. **明显遗漏**：存在明显遗漏的关键操作
   - 例如：生成内容后未保存、查询后未通知
2. **目标未达成**：任务目标中明确要求的步骤未执行
   - 例如：要求"搜索并总结"，只搜索未总结
3. **可用未用**：可用工具中有明显适用但未使用的工具
   - 例如：生成图片但未验证、写入文件但未读取
4. **需要验证**：执行结果需要验证但未验证
   - 例如：图片生成后未查看、文件写入后未读取

**示例**：
- 生成了插画但未保存到文件 → 不完整（建议补充：保存文件）
- 查询了信息但用户要求发送通知，未发送 → 不完整（建议补充：发送通知）
- 创建了报告但未验证格式 → 不完整（建议补充：验证报告）

## 约束与原则

### ⚠️ 避免过度补充

- **不为了使用工具而使用工具**：只建议对任务目标有实质性帮助的操作
- **不建议无关操作**：不建议与任务目标无关的操作
- **不重复操作**：不建议重复已执行的操作（除非有明确理由）

### 🎯 优先级判断

- **只建议关键操作**：对任务目标有实质性帮助的操作
- **忽略次要操作**：可选的、次要的操作不应建议
- **限制数量**：最多补充 `REFLECTION_MAX_SUPPLEMENTS` 个操作（默认 3 个）

### 🔧 工具匹配

- **从可用工具选择**：`suggested_tools` 必须从可用工具列表中选择
- **允许不确定**：如果不确定具体工具，可以留空（由后续规划决定）

## 配置选项

### 环境变量

```bash
# 启用 Reflection 机制（默认：true）
ENABLE_REFLECTION=true

# 最多补充的操作数量（默认：3）
REFLECTION_MAX_SUPPLEMENTS=3

# Reflection 阶段的 FC 模型（可选，未设置则回退到 FC_MODEL）
REFLECTION_FC_MODEL=gpt-4o-mini

# Reflection 阶段的采样参数（可选）
FC_REFLECTION_TEMPERATURE=0.2
FC_REFLECTION_TOP_P=

# Reflection 阶段的最大重试次数（默认：2）
FC_REFLECTION_MAX_RETRIES=2
```

### 代码配置

在 `config/index.js` 中：

```javascript
config.flags.enableReflection = bool(process.env.ENABLE_REFLECTION, true);
config.flags.reflectionMaxSupplements = int(process.env.REFLECTION_MAX_SUPPLEMENTS, 3);

config.fcLlm.reflectionModel = process.env.REFLECTION_FC_MODEL || '';
config.fcLlm.reflectionTemperature = Number(process.env.FC_REFLECTION_TEMPERATURE || 'NaN');
config.fcLlm.reflectionTopP = Number(process.env.FC_REFLECTION_TOP_P || 'NaN');
config.fcLlm.reflectionMaxRetries = int(process.env.FC_REFLECTION_MAX_RETRIES, 2);
```

## 事件流

Reflection 机制在 `planThenExecuteStream` 中发出以下事件：

### 1. `reflection` 事件

完整性检查结果：

```javascript
{
  type: 'reflection',
  isComplete: true/false,
  analysis: '完整性分析说明',
  missingsCount: 0,
  supplementsCount: 0
}
```

### 2. `reflection_plan` 事件（仅当需要补充时）

补充计划生成成功：

```javascript
{
  type: 'reflection_plan',
  plan: { manifest, steps },
  supplementsCount: 3
}
```

### 3. `reflection_exec` 事件（仅当需要补充时）

补充步骤执行完成：

```javascript
{
  type: 'reflection_exec',
  exec: { used, attempted, succeeded, successRate }
}
```

## 技术实现

### 核心文件

1. **Schema 定义**：`src/agent/tools/internal/check_completeness.schema.json`
   - 定义 Reflection 输出格式

2. **提示词模板**：`src/agent/prompts/reflection_fc.json`
   - 包含完整性检查的系统提示和用户提示

3. **阶段实现**：`src/agent/stages/reflection.js`
   - `checkTaskCompleteness()` 函数：执行完整性检查

4. **集成点**：`src/agent/planners.js`
   - 在 `planThenExecuteStream` 的 `done` 和 `summary` 之间调用

### 数据流

```
执行历史 ─┐
         │
可用工具 ─┼─► checkTaskCompleteness() ─► { isComplete, analysis, supplements }
         │
任务目标 ─┘
                                            │
                                            ▼
                              if (!isComplete && supplements.length > 0)
                                            │
                                            ▼
                              generatePlan(supplementObjective) ─► supplementPlan
                                            │
                                            ▼
                              executePlan(supplementPlan, seedRecent=prior)
                                            │
                                            ▼
                              更新全局 exec 统计
```

## 学术基础

Reflection 机制基于以下学术研究和最佳实践：

### 1. **Global Reflection vs Local Reflection**

来源：[Large Language Model-based Data Science Agent: A Survey (arXiv:2508.02744v1)](https://arxiv.org/html/2508.02744v1)

- **Local Reflection**：聚焦单个任务迭代，快速但可能错过系统性问题
- **Global Reflection**：分析多个迭代的模式，提取长期优化洞察

**我们的选择**：Global Reflection，因为任务完整性是全局问题

### 2. **Feedback-Driven vs Goal-Driven**

- **Feedback-Driven**：基于外部反馈（人类或其他 Agent）
- **Goal-Driven**：基于预定义性能标准（如指标、阈值）

**我们的选择**：Goal-Driven，基于任务目标判断完整性

### 3. **Structured vs Adaptive Reflection**

- **Structured Reflection**：固定评估标准（如单元测试、阈值）
- **Adaptive Reflection**：动态调整策略（如自修改历史窗口）

**我们的选择**：Adaptive，根据上下文动态调整判断标准

### 4. **Reflection Methods**

参考的反思方法：

- **Agent Feedback**：一个 Agent 审查另一个 Agent 的输出
- **Code Error Handling**：监控执行失败，自动诊断和修复
- **History Window**：维护过去输出和错误的日志，识别模式

**我们的实现**：结合 Agent Feedback（Reflection Agent 审查执行历史）和 History Window（分析完整执行历史）

## 使用场景

### 场景 1：生成内容后需要保存

**任务**：生成两个伪人角色插画（录像带女孩、替代者）

**执行历史**：
- 步骤 0：`local__image_draw`（成功）→ 生成图片 1
- 步骤 1：`local__image_draw`（成功）→ 生成图片 2

**Reflection 分析**：
- **判断**：不完整（生成内容后未保存）
- **遗漏方面**：["持久化保存"]
- **补充建议**：
  - 操作：保存生成的图片到文件
  - 原因：避免内容丢失，便于后续使用
  - 建议工具：`local__file_write`

### 场景 2：查询信息后需要通知

**任务**：搜索最新 AI 动态并通知用户

**执行历史**：
- 步骤 0：`search_web`（成功）→ 获取 AI 新闻列表

**Reflection 分析**：
- **判断**：不完整（查询后未发送通知）
- **遗漏方面**：["用户通知"]
- **补充建议**：
  - 操作：发送搜索结果通知
  - 原因：任务明确要求通知用户
  - 建议工具：`qq_message_send`

### 场景 3：任务已完整，无需补充

**任务**：读取配置文件并解析

**执行历史**：
- 步骤 0：`local__file_read`（成功）→ 读取文件内容
- 步骤 1：`local__json_parse`（成功）→ 解析 JSON

**Reflection 分析**：
- **判断**：完整（任务目标已充分达成）
- **分析**：所有必要操作已执行，无明显遗漏
- **补充建议**：[]

## 禁用 Reflection

如果不需要 Reflection 机制，可以通过环境变量禁用：

```bash
ENABLE_REFLECTION=false
```

禁用后，任务将直接从 `done` 阶段进入 `summary` 阶段，不进行完整性检查。

## 调试与日志

启用详细日志：

```bash
ENABLE_VERBOSE_STEPS=true
LOG_PRETTY_LABELS=PLAN,PLAN_STEP,STEP,ARGS,RESULT,PLUGIN,REDIS,MCP,RUN,EVAL,RETRY,REFLECTION
```

Reflection 阶段的关键日志：

```
[REFLECTION] Reflection: 完整性检查完成
  - isComplete: false
  - missingsCount: 1
  - supplementsCount: 1
  
[REFLECTION] Reflection: 开始生成补充计划
  - supplementsCount: 1
  - supplements: ["保存生成结果"]
  
[REFLECTION] Reflection: 补充计划生成成功
  - stepsCount: 1
  - steps: ["local__file_write: 保存图片到文件"]
  
[REFLECTION] Reflection: 补充执行完成
  - supplementAttempted: 1
  - supplementSucceeded: 1
  - globalAttempted: 3
  - globalSucceeded: 3
```

## 性能考虑

### 额外开销

- **LLM 调用**：1 次（完整性检查）
- **规划开销**：如果需要补充，增加 1 次规划调用
- **执行开销**：补充步骤的执行时间（最多 `REFLECTION_MAX_SUPPLEMENTS` 个步骤）

### 优化策略

1. **限制补充数量**：通过 `REFLECTION_MAX_SUPPLEMENTS` 控制
2. **使用小模型**：为 Reflection 阶段配置较小的模型（如 `gpt-4o-mini`）
3. **禁用不需要的场景**：对于简单任务，可以禁用 Reflection

### 估算影响

假设：
- 完整性检查：~2 秒（LLM 调用）
- 补充规划：~3 秒（如果需要）
- 补充执行：~5-15 秒（取决于工具）

**总计**：2-20 秒额外时间（仅当任务不完整时）

## 最佳实践

### 1. 合理配置补充数量

```bash
# 简单任务（如单步操作）
REFLECTION_MAX_SUPPLEMENTS=1

# 复杂任务（如多步工作流）
REFLECTION_MAX_SUPPLEMENTS=3

# 非常复杂的任务
REFLECTION_MAX_SUPPLEMENTS=5
```

### 2. 使用专用模型

为 Reflection 阶段配置更强的模型：

```bash
# 全局使用小模型
FC_MODEL=gpt-4o-mini

# Reflection 使用更强的模型（判断更准确）
REFLECTION_FC_MODEL=gpt-4o
```

### 3. 根据场景启用/禁用

- **生产环境**：启用 Reflection，确保任务完整性
- **开发测试**：可选禁用，加快迭代速度
- **演示环境**：启用 Reflection，展示系统智能

### 4. 监控补充频率

定期检查 Reflection 日志，如果发现：

- **补充过多**：可能是判断标准过于严格，考虑调整提示词
- **补充过少**：可能是判断标准过于宽松，验证任务质量
- **补充不准确**：可能是模型能力不足，考虑升级模型

## 未来扩展

### 1. 学习型 Reflection

- **记忆补充模式**：记录常见的补充操作模式
- **自适应阈值**：根据历史数据调整判断标准

### 2. 多模态 Reflection

- **图像验证**：对生成的图片进行质量检查
- **文件验证**：对生成的文件进行格式验证

### 3. 成本感知 Reflection

- **成本评估**：评估补充操作的成本效益
- **选择性补充**：优先补充高价值、低成本的操作

## 总结

Reflection 机制是 Sentra-MCP 任务完整性保障的核心组件，基于学术最佳实践，提供智能的全局任务分析和自动补充能力。通过合理配置和使用，可以显著提升任务执行的完整性和质量。
