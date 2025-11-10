# Evaluation failedSteps 强制填写优化

## 🎯 问题描述

### 问题现象
```javascript
{
  runId: 'e5685354-b50d-4499-8772-1308117f0a5d',
  type: 'evaluation',
  result: {
    success: false,      // ❌ 有步骤失败
    incomplete: true,
    failedSteps: [],     // ❌ 但失败步骤列表为空！
    summary: '...有几个思维导图生成失败了，还有那个恐怖页面的渲染图片也超时了...'
  }
}
```

### 问题根源

**缺少强制约束**：
- 提示词只说"在 failedSteps 中定位"，但没有**强制要求**必须填写
- Schema 中 failedSteps 不在 `required` 数组中
- 没有验证逻辑检查：当 `success=false` 时 failedSteps 是否为空

**导致的问题**：
1. ❌ 无法知道具体哪些步骤失败
2. ❌ 无法针对性重试失败的步骤
3. ❌ 只有模糊的 summary，缺少结构化失败信息
4. ❌ 后续 reflection 或重试机制无法使用失败步骤信息

---

## ✅ 优化方案

### 核心原则

**强制约束**：当 `success=false` 时，`failedSteps` **绝对不能为空**！

### 三层保障

| 层级 | 文件 | 优化内容 |
|------|------|---------|
| 1️⃣ **Schema 层** | `final_judge.schema.json` | 增强字段说明，明确要求 |
| 2️⃣ **提示词层** | `final_judge.json` | 增加专门的 failedSteps 填写指引 |
| 3️⃣ **验证层** | `evaluate.js` | 解析后验证，不符合则触发重试 |

---

## 📝 详细修改

### 1️⃣ Schema 优化（final_judge.schema.json）

**新增详细说明**：
```json
{
  "failedSteps": {
    "type": "array",
    "description": "失败步骤列表。**关键：当 success=false 时，此字段绝对不能为空数组！必须详细列出所有 res.success=false 的步骤。**当 success=true 时，为空数组 []。",
    "items": {
      "type": "object",
      "properties": {
        "index": { 
          "type": "integer",
          "description": "步骤索引（从 0 开始，对应执行历史中的位置）"
        },
        "aiName": { 
          "type": "string",
          "description": "失败的工具名称（如 mindmap_gen, web_render_image）"
        },
        "reason": { 
          "type": "string",
          "description": "具体失败原因（如"超时"、"文件不存在"、"API 错误"），不要简单写"失败""
        }
      },
      "required": ["index", "reason"]
    }
  }
}
```

**关键点**：
- ✅ 明确说明"当 success=false 时不能为空"
- ✅ 详细说明每个字段的含义
- ✅ reason 要求具体，不能简单写"失败"

---

### 2️⃣ 提示词优化（final_judge.json）

**增加专门的 failedSteps 章节**：
```
【failedSteps 字段】当 success=false 时的必填要求：
⚠️ **关键：当 success=false 时，failedSteps 绝对不能为空数组！**
1) **必须详细列出所有失败的步骤**，包含：
   - index：步骤索引（从 0 开始）
   - aiName：工具名称（如 mindmap_gen、web_render_image）
   - reason：失败原因（如"超时"、"文件不存在"、"API 错误"）
2) 从执行历史中找到 res.success=false 或 res.success=0 的步骤。
3) 如果多个步骤失败，**全部列出**，不要遮漏。
4) reason 字段要具体，不要简单写"失败"。
```

**输出示例**（新增）：
```
- 所有步骤成功且目标完整：{success:true, incomplete:false, failedSteps:[]}
- 所有步骤成功但有遗漏：{success:true, incomplete:true, failedSteps:[]}
- 有步骤失败：{success:false, incomplete:true, failedSteps:[
    {index:3, aiName:'mindmap_gen', reason:'生成超时'},
    {index:7, aiName:'web_render_image', reason:'页面渲染超时'}
  ]}
```

**优化前**：
```
3) 若任一步骤 res.success=false 或发生异常，则 success=false，并在 failedSteps 中定位。
```
- ⚠️ 只说"并在 failedSteps 中定位"，不够强制

**优化后**：
```
3) 若任一步骤 res.success=false 或发生异常，则 success=false。

【failedSteps 字段】当 success=false 时的必填要求：
⚠️ **关键：当 success=false 时，failedSteps 绝对不能为空数组！**
1) **必须详细列出所有失败的步骤**...
```
- ✅ 独立章节，强调"绝对不能为空"
- ✅ 提供详细的填写指引和示例

---

### 3️⃣ 验证逻辑（evaluate.js）

**Native Tools 模式验证**（L110-119）：
```javascript
// 验证：当 success=false 时，failedSteps 不能为空
if (result.success === false && (!Array.isArray(result.failedSteps) || result.failedSteps.length === 0)) {
  logger.warn('Evaluation 验证失败：success=false 但 failedSteps 为空，这不符合要求！', {
    label: 'EVAL',
    runId,
    success: result.success,
    failedStepsCount: result.failedSteps?.length || 0,
    summary: result.summary?.slice(0, 200)
  });
}
```

**FC 模式验证 + 重试**（L179-191）：
```javascript
// 验证：当 success=false 时，failedSteps 不能为空
if (result.success === false && (!Array.isArray(result.failedSteps) || result.failedSteps.length === 0)) {
  logger.warn('Evaluation 验证失败：success=false 但 failedSteps 为空，尝试重试', {
    label: 'EVAL',
    runId,
    attempt,
    success: result.success,
    failedStepsCount: result.failedSteps?.length || 0,
    summary: result.summary?.slice(0, 200)
  });
  // 不 break，继续重试下一轮
  continue;
}

// 若解析到且验证通过则完成
break;
```

**关键点**：
- ✅ Native 模式：记录警告（不阻塞流程，因为只有一次机会）
- ✅ FC 模式：触发重试（继续下一轮，最多重试 maxRetries 次）
- ✅ 只有验证通过才 `break` 完成评估

---

### 4️⃣ 重试提示词优化（fc_reinforce_eval.json）

**优化前**：
```json
"zh": "上轮未解析到有效 final_judge，请仅输出一个 <sentra-tools> 块重新返回：
- 请给出 success、可选 failedSteps 与 summary
- 第 {{attempt}} 次尝试（最多 {{max_retries}} 次）"
```
- ⚠️ 说 failedSteps 是"可选"，容易被忽略

**优化后**：
```json
"zh": "上轮未解析到有效 final_judge 或不符合要求，请仅输出一个 <sentra-tools> 块重新返回：
- 必须给出 success, incomplete, summary
- ⚠️ **关键：如果 success=false，必须详细填写 failedSteps 数组，不能为空！**
- 从执行历史中找到 res.success=false 的步骤，列出 index, aiName, reason
- 第 {{attempt}} 次尝试（最多 {{max_retries}} 次）"
```
- ✅ 明确强调"必须详细填写"
- ✅ 提供具体操作指引："从执行历史中找到..."

---

## 📊 优化前后对比

### 案例：思维导图和渲染失败

#### 优化前（❌ 错误）
```javascript
{
  success: false,
  incomplete: true,
  failedSteps: [],  // ❌ 空数组
  summary: "有几个思维导图生成失败了，还有那个恐怖页面的渲染图片也超时了"
}

// 问题：
// 1. 不知道具体是哪几个思维导图失败
// 2. 不知道失败的步骤索引，无法重试
// 3. 只有模糊的文字描述
```

#### 优化后（✅ 正确）
```javascript
{
  success: false,
  incomplete: true,
  failedSteps: [  // ✅ 详细列出
    { index: 3, aiName: "mindmap_gen", reason: "天气思维导图生成超时" },
    { index: 5, aiName: "mindmap_gen", reason: "MDN 思维导图生成超时" },
    { index: 7, aiName: "mindmap_gen", reason: "日程思维导图生成超时" },
    { index: 10, aiName: "web_render_image", reason: "恐怖页面渲染超时（等待60秒）" }
  ],
  summary: "已完成天气查询、文件写入、图片绘制和应用打包。失败步骤：3个思维导图生成超时，1个页面渲染超时。"
}

// 优势：
// 1. ✅ 明确知道失败的是步骤 3, 5, 7, 10
// 2. ✅ 知道具体工具：mindmap_gen (3个), web_render_image (1个)
// 3. ✅ 知道具体原因：超时
// 4. ✅ 可以针对性重试这4个步骤
```

---

## 🎯 优化效果

### 1. 结构化失败信息

**优化前**：
```javascript
summary: "有几个思维导图生成失败了"
// ❌ 模糊：几个？哪些？为什么失败？
```

**优化后**：
```javascript
failedSteps: [
  { index: 3, aiName: "mindmap_gen", reason: "天气思维导图生成超时" },
  { index: 5, aiName: "mindmap_gen", reason: "MDN 思维导图生成超时" },
  { index: 7, aiName: "mindmap_gen", reason: "日程思维导图生成超时" }
]
// ✅ 清晰：3个，分别是步骤3/5/7，都是mindmap_gen，原因都是超时
```

---

### 2. 可针对性重试

**优化前**：
```javascript
// 无法重试：不知道具体哪些步骤失败
if (evalResult.success === false) {
  // ❌ 只能整体重试所有步骤？
}
```

**优化后**：
```javascript
// 可以针对性重试
if (evalResult.success === false && evalResult.failedSteps.length > 0) {
  for (const failed of evalResult.failedSteps) {
    // ✅ 重试特定步骤：failed.index, failed.aiName
    await retryStep(failed.index, failed.aiName, failed.reason);
  }
}
```

---

### 3. 更好的错误诊断

**优化前**：
```javascript
// 日志中只有模糊信息
logger.error('任务失败', { summary: '有几个思维导图生成失败了' });
// ❌ 无法定位具体问题
```

**优化后**：
```javascript
// 日志中有详细失败信息
logger.error('任务失败', { 
  failedCount: 4,
  failedTools: ['mindmap_gen', 'mindmap_gen', 'mindmap_gen', 'web_render_image'],
  failedReasons: ['超时', '超时', '超时', '渲染超时'],
  failedIndices: [3, 5, 7, 10]
});
// ✅ 可以快速定位：mindmap_gen 容易超时，需要优化超时设置
```

---

### 4. 验证 + 重试机制

**FC 模式流程**：
```
第1次评估 → success=false, failedSteps=[] 
  → 验证失败 → 记录警告 → 继续重试

第2次评估 → success=false, failedSteps=[...]
  → 验证通过 → break → 返回结果
```

**关键点**：
- ✅ 自动检测不符合要求的结果
- ✅ 自动触发重试（FC 模式）
- ✅ 最多重试 `maxRetries` 次（默认3次）

---

## 📋 修改文件清单

1. ✅ `src/agent/tools/internal/final_judge.schema.json`
   - 增强 failedSteps 字段描述
   - 详细说明每个子字段的含义

2. ✅ `src/agent/prompts/final_judge.json`
   - 增加【failedSteps 字段】独立章节
   - 强调"绝对不能为空"
   - 提供详细填写指引和示例

3. ✅ `src/agent/stages/evaluate.js`
   - Native 模式：增加验证 + 警告（L110-119）
   - FC 模式：增加验证 + 重试（L179-191）

4. ✅ `src/agent/prompts/fc_reinforce_eval.json`
   - 更新重试提示词
   - 强调 failedSteps 必填

5. ✅ `docs/EVALUATION_FAILEDSTEPS_FIX.md`
   - 本优化文档

---

## 🧪 测试建议

### 测试用例 1：单个步骤失败
```javascript
// 模拟场景：文件读取失败
用户目标: "读取 E:/data.txt 并分析"
执行历史: [
  { type: 'tool_result', aiName: 'document_read', result: { success: false, error: '文件不存在' } }
]

// 预期 Evaluation 输出：
{
  success: false,
  incomplete: true,
  failedSteps: [
    { index: 0, aiName: "document_read", reason: "文件不存在" }
  ],
  summary: "文件读取失败，无法继续分析。"
}
```

### 测试用例 2：多个步骤失败
```javascript
// 模拟场景：多个思维导图生成超时
用户目标: "生成3个思维导图"
执行历史: [
  { type: 'tool_result', aiName: 'mindmap_gen', result: { success: false, error: '超时' } },
  { type: 'tool_result', aiName: 'mindmap_gen', result: { success: true } },
  { type: 'tool_result', aiName: 'mindmap_gen', result: { success: false, error: '超时' } }
]

// 预期 Evaluation 输出：
{
  success: false,
  incomplete: true,
  failedSteps: [
    { index: 0, aiName: "mindmap_gen", reason: "生成超时" },
    { index: 2, aiName: "mindmap_gen", reason: "生成超时" }
  ],
  summary: "3个思维导图中有2个生成超时，1个成功。"
}
```

### 测试用例 3：所有步骤成功
```javascript
// 模拟场景：完美执行
用户目标: "查询天气并生成报告"
执行历史: [
  { type: 'tool_result', aiName: 'weather', result: { success: true } },
  { type: 'tool_result', aiName: 'write_file', result: { success: true } }
]

// 预期 Evaluation 输出：
{
  success: true,
  incomplete: false,
  failedSteps: [],  // ✅ success=true 时可以为空
  summary: "已成功查询天气并生成报告。"
}
```

### 测试用例 4：验证触发重试
```javascript
// 模拟场景：第1次输出 failedSteps 为空，触发重试
第1次评估输出:
{
  success: false,
  failedSteps: []  // ❌ 不符合要求
}
→ 验证失败 → 记录警告 → 继续重试

第2次评估输出:
{
  success: false,
  failedSteps: [{ index: 3, aiName: "mindmap_gen", reason: "超时" }]  // ✅ 符合要求
}
→ 验证通过 → 完成评估
```

---

## 💡 最佳实践

### LLM 输出示例

#### ❌ 错误示例（会触发警告/重试）
```xml
<sentra-tools>
  <invoke name="final_judge">
    <parameter name="success">false</parameter>
    <parameter name="incomplete">true</parameter>
    <parameter name="failedSteps">[]</parameter>  <!-- ❌ 空数组 -->
    <parameter name="summary">有些步骤失败了</parameter>
  </invoke>
</sentra-tools>
```

#### ✅ 正确示例
```xml
<sentra-tools>
  <invoke name="final_judge">
    <parameter name="success">false</parameter>
    <parameter name="incomplete">true</parameter>
    <parameter name="failedSteps">[
      {"index": 3, "aiName": "mindmap_gen", "reason": "天气思维导图生成超时（60秒）"},
      {"index": 5, "aiName": "mindmap_gen", "reason": "MDN 思维导图生成超时（60秒）"},
      {"index": 7, "aiName": "mindmap_gen", "reason": "日程思维导图生成超时（60秒）"},
      {"index": 10, "aiName": "web_render_image", "reason": "恐怖页面渲染超时（等待资源加载）"}
    ]</parameter>
    <parameter name="summary">已完成天气查询、文件写入（3个TXT）、图片绘制和应用打包。失败步骤：3个思维导图生成超时，1个页面渲染超时。建议：增加超时时间或优化生成策略。</parameter>
  </invoke>
</sentra-tools>
```

---

## 🔧 配置建议

### 调整重试次数
```javascript
// .env 或 config
FC_EVAL_MAX_RETRIES=3  // 默认3次，可根据需要调整
```

### 调整超时时间
```javascript
// 如果经常因为超时导致 failedSteps 过多
PLUGIN_TIMEOUT_MS=120000  // 增加插件超时时间（如120秒）
```

---

## 📚 相关文档

- `docs/EVALUATION_INCOMPLETE_OPTIMIZATION.md` - Evaluation incomplete 字段优化
- `src/agent/stages/evaluate.js` - 评估阶段实现
- `src/agent/tools/internal/final_judge.schema.json` - Schema 定义
- `src/agent/prompts/final_judge.json` - 提示词模板

---

## 🎉 总结

### 核心改进
- ✅ 增加【failedSteps 字段】独立章节，强调"绝对不能为空"
- ✅ 详细说明如何填写：index, aiName, reason
- ✅ 增加验证逻辑：success=false 但 failedSteps 为空时触发重试
- ✅ 更新重试提示词，明确要求

### 预期效果
- 🚀 100% 的失败场景都有详细的 failedSteps 信息
- 🚀 可以针对性重试失败的步骤
- 🚀 更好的错误诊断和日志记录
- 🚀 提升整体任务成功率

### 适用场景
- 所有使用 evaluation 的任务流程
- 特别适用于多步骤、容易失败的场景（如网络请求、文件操作、超时等）
- 需要精确失败信息用于重试或诊断的场景
