# ArgGen 消息数组构建流程全面分析

## 概述

ArgGen 阶段负责为每个计划步骤生成工具调用参数。它通过构建一个消息数组（messages）来向 LLM 请求参数生成。

## 核心流程（FC 模式）

### 第一步：判断是否使用 FC 模式

```javascript
// arggen.js L61
const useFC = String(config.llm?.toolStrategy || 'auto') === 'fc';
```

### 第二步：构建上下文（L63-65）

```javascript
// 构建上下文（FC 模式使用 XML 格式）
const dialogueMsgs = await buildToolDialogueMessages(runId, stepIndex, useFC);
const depAppendText = await buildDependentContextText(runId, step.dependsOn, useFC);
```

#### `buildToolDialogueMessages` 返回值

**作用**：获取当前步骤依赖链上的历史工具调用和结果

**FC 模式输出**：
```javascript
[
  { 
    role: 'assistant', 
    content: `<sentra-tools>
  <invoke name="local__image_draw">
    <parameter name="prompt">...</parameter>
  </invoke>
</sentra-tools>

<sentra-result step="0" tool="local__image_draw" success="true">
  <reason>绘制Logo</reason>
  <arguments>{"prompt":"..."}</arguments>
  <data>{"path":"E:/...","url":"..."}</data>
</sentra-result>` 
  }
]
```

**非 FC 模式输出**：
```javascript
[
  { role: 'user', content: '现在该使用 local__image_draw 了。原因: ...' },
  { role: 'assistant', content: '参数(JSON): {...}\n结果(JSON): {...}' }
]
```

#### `buildDependentContextText` 返回值

**作用**：获取当前步骤直接声明的依赖结果（不包含间接依赖）

**FC 模式输出**：
```javascript
// 纯 XML 字符串（会追加到最终 user 消息）
`<sentra-result step="0" tool="local__image_draw" success="true">
  <reason>...</reason>
  <arguments>...</arguments>
  <data>...</data>
</sentra-result>`
```

**非 FC 模式输出**：
```javascript
`
依赖结果(JSON):
[
  {
    "plannedStepIndex": 0,
    "aiName": "local__image_draw",
    "argsPreview": "...",
    "resultPreview": "..."
  }
]`
```

### 第三步：加载提示词模板（L93）

```javascript
const ap = await loadPrompt(useFC ? 'arggen_fc' : 'arggen');
```

**FC 模式模板** (`arggen_fc.json`):
```json
{
  "user_task": "<sentra-user-question>\n  <objective>{{objective}}</objective>\n  <current_step>{{stepIndex}}/{{totalSteps}}</current_step>\n  <tool_name>{{aiName}}</tool_name>\n  ...\n</sentra-user-question>"
}
```

**非 FC 模式模板** (`arggen.json`):
```json
{
  "user_task": "【总体目标】{{objective}}\n【当前步骤】{{stepIndex}}/{{totalSteps}}\n【要调用的工具】{{aiName}}\n..."
}
```

### 第四步：构建 system 消息（L98-108）

```javascript
if (useFC) {
  const policy = await buildFCPolicy({ locale: 'zh-CN' });
  const userSystem = [overlayGlobal, overlayArgs, ap.system].filter(Boolean).join('\n\n');
  systemContent = userSystem 
    ? `${policy}\n\n---\n【Protocol Requirements】Above is system protocol...\n---\n\n${userSystem}`
    : policy;
}
```

**输出示例**：
```
Sentra XML 协议使用说明：

本系统使用 Sentra XML 协议表示所有结构化数据，包含三个核心标签：

1. <sentra-user-question> - 用户原始问题标记
2. <sentra-tools> - 工具调用（你主动发起），格式：<invoke name=工具名><parameter name=参数名>值</parameter></invoke>
3. <sentra-result> - 工具执行结果...

---
【Protocol Requirements】Above is system protocol, must be strictly followed. Below are specific task settings and requirements:
---

You are a precise tool parameter generator. Based on user objectives and current step requirements, generate JSON parameters that strictly conform to the schema...
```

### 第五步：处理对话历史（L114）

```javascript
const convWrapped = useFC ? [] : conv;
```

**FC 模式**：清空对话历史，避免污染 XML 结构
**非 FC 模式**：保留原始对话

### 第六步：渲染任务指令（L116-125）

```javascript
const taskInstruction = renderTemplate(ap.user_task, {
  objective: objectiveText,
  stepIndex: stepIndex + 1,
  totalSteps,
  aiName,
  reason: reason || '',
  description: currentToolFull?.description || '',
  requiredList: Array.isArray(requiredList) && requiredList.length ? requiredList.join(', ') : '(无)',
  requiredDetail: requiredDetail || '(无)'
});
```

**输出示例（FC 模式）**：
```xml
<sentra-user-question>
  <objective>失语画个紧急通知的logo，然后渲染为HTML页面给我看</objective>
  <current_step>2/2</current_step>
  <tool_name>local__web_render_image</tool_name>
  <tool_reason>将步骤0生成的图片链接嵌入到HTML代码中...</tool_reason>
  <tool_description>将 HTML 或 URL 渲染为图片...</tool_description>
  <required_params>html, url, file</required_params>
  <param_details>
    - html: 要渲染的 HTML 字符串
    - url: 要渲染的网页 URL
    - file: 要渲染的本地 HTML 文件路径
  </param_details>
</sentra-user-question>
```

### 第七步：组装 baseMessages（L127-132）

```javascript
const baseMessages = compactMessages([
  { role: 'system', content: systemContent },
  ...convWrapped,
  ...dialogueMsgs,
  { role: 'user', content: [taskInstruction, depAppendText || ''].filter(Boolean).join('\n\n') }
]);
```

**关键点**：
- `compactMessages` 会合并相邻同角色消息
- `taskInstruction + depAppendText` 合并为一条 user 消息

**输出示例（FC 模式）**：
```javascript
[
  { 
    role: 'system', 
    content: 'Sentra XML 协议使用说明...\n\n---\n【Protocol Requirements】...\n\n---\n\nYou are a precise tool parameter generator...' 
  },
  { 
    role: 'assistant', 
    content: '<sentra-tools>...</sentra-tools>\n\n<sentra-result step="0" tool="local__image_draw">...</sentra-result>' 
  },
  { 
    role: 'user', 
    content: '<sentra-user-question>\n  <objective>...</objective>\n  ...\n</sentra-user-question>' 
  }
]
```

### 第八步：构建 FC 模式最终消息（L143-154）

```javascript
const instruction = await buildFunctionCallInstruction({ 
  name: aiName, 
  parameters: currentToolFull?.inputSchema || { type: 'object', properties: {} }, 
  locale: 'zh-CN' 
});

const messagesFC = [...baseMessages, { 
  role: 'user', 
  content: [reinforce, instruction].filter(Boolean).join('\n\n') 
}];
```

**问题所在**：这里又追加了一条新的 user 消息！

**instruction 内容示例**：
```
请仅输出且仅输出一个工具调用块，使用 Sentra XML 协议格式：
<sentra-tools>
  <invoke name="local__web_render_image">
    <parameter name="param1">value1</parameter>
    <parameter name="param2">{"key": "value"}</parameter>
  </invoke>
</sentra-tools>

【Schema 定义】
{
  "type": "object",
  "properties": {
    "html": { "type": "string", "description": "..." },
    "url": { "type": "string", "description": "..." },
    ...
  },
  "required": ["html", "url", "file"]
}

- 必须包含必填字段: html, url, file
...
```

### 第九步：最终消息数组

```javascript
messagesFC = [
  { role: 'system', content: '...' },           // index 0: 协议说明
  { role: 'assistant', content: '...' },        // index 1: 历史工具调用XML
  { role: 'user', content: '<sentra-user-question>...' },  // index 2: 任务上下文XML
  { role: 'user', content: '请仅输出且仅输出一个工具调用块...' }  // index 3: 工具调用指令
]
```

## 问题分析

### 当前问题

**症状**：出现两条连续的 user 消息（index 2 和 3）

**原因**：
1. `baseMessages` 已包含一条 user（taskInstruction + depAppendText）
2. L154 又追加了一条 user（reinforce + instruction）
3. 这两条 user 消息没有被 `compactMessages` 合并（因为是在构建后才追加的）

### 设计意图分析

**为什么要分两条 user？**

1. **任务上下文**（index 2）：
   - 总体目标
   - 当前步骤信息
   - 工具描述
   - 参数详情
   - 依赖结果

2. **调用指令**（index 3）：
   - 强制格式要求
   - Schema 定义
   - 必填字段提醒
   - 重试增强信息

**潜在问题**：
- 两条 user 消息可能让模型困惑"哪个是真正的问题"
- 不符合典型的对话模式（user → assistant → user → assistant）

## 解决方案

### 方案 A：合并到 baseMessages（推荐）

```javascript
// 在构建 baseMessages 时就包含 instruction
const baseMessages = compactMessages([
  { role: 'system', content: systemContent },
  ...convWrapped,
  ...dialogueMsgs,
  { role: 'user', content: [taskInstruction, depAppendText, instruction].filter(Boolean).join('\n\n') }
]);

// 重试时直接使用 baseMessages，仅更新 reinforce
const messagesFC = reinforce 
  ? [...baseMessages.slice(0, -1), { 
      role: 'user', 
      content: [baseMessages[baseMessages.length - 1].content, reinforce].join('\n\n') 
    }]
  : baseMessages;
```

### 方案 B：使用 compactMessages 后处理

```javascript
const messagesFC = compactMessages([
  ...baseMessages, 
  { role: 'user', content: [reinforce, instruction].filter(Boolean).join('\n\n') }
]);
```

**优势**：自动合并相邻 user 消息

### 方案 C：调整角色分配

```javascript
// instruction 作为 system 的一部分（在最开始就说明格式要求）
// 或作为 assistant 的提示（"我来帮你生成参数，请提供..."）
```

## 最佳实践建议

### FC 模式消息结构（推荐）

```javascript
[
  { 
    role: 'system', 
    content: `${policy}\n\n${userSystem}` 
  },
  { 
    role: 'assistant', 
    content: '<sentra-tools>...</sentra-tools>\n\n<sentra-result>...</sentra-result>' 
  },
  { 
    role: 'user', 
    content: `<sentra-user-question>
  <objective>...</objective>
  <current_step>...</current_step>
  ...
</sentra-user-question>

${depAppendText}

${instruction}` 
  }
]
```

**优势**：
- 单条 user 消息，结构清晰
- 任务上下文 + 依赖结果 + 调用指令 完整呈现
- 符合对话交替模式
- 便于模型理解"这是一个完整的请求"

### 非 FC 模式消息结构

```javascript
[
  { role: 'system', content: '...' },
  { role: 'user', content: '现在该使用 xxx 了。原因: ...' },
  { role: 'assistant', content: '参数(JSON): {...}\n结果(JSON): {...}' },
  { role: 'user', content: '【总体目标】...\n【当前步骤】...\n...\n依赖结果(JSON):...' }
]
```

## 相关文件

- `src/agent/stages/arggen.js`: 主逻辑
- `src/agent/plan/history.js`: 历史上下文构建
- `src/agent/prompts/arggen_fc.json`: FC 模式模板
- `src/agent/prompts/arggen.json`: 默认模式模板
- `src/utils/fc.js`: Sentra XML 工具函数

## 示例对比

### 当前输出（有问题）

```javascript
[
  { role: 'system', content: '协议说明...' },
  { role: 'assistant', content: '<sentra-tools>...</sentra-tools>\n<sentra-result>...</sentra-result>' },
  { role: 'user', content: '<sentra-user-question>...</sentra-user-question>' },  // 问题1：任务上下文
  { role: 'user', content: '请仅输出且仅输出一个工具调用块...' }  // 问题2：调用指令
]
```

### 优化后输出（推荐）

```javascript
[
  { role: 'system', content: '协议说明...' },
  { role: 'assistant', content: '<sentra-tools>...</sentra-tools>\n<sentra-result>...</sentra-result>' },
  { 
    role: 'user', 
    content: `<sentra-user-question>...</sentra-user-question>

请仅输出且仅输出一个工具调用块，使用 Sentra XML 协议格式...` 
  }
]
```

## 总结

ArgGen 消息构建流程分为9个步骤：
1. 判断 FC 模式
2. 构建历史上下文（dialogueMsgs + depAppendText）
3. 加载提示词模板
4. 构建 system 消息
5. 处理对话历史（FC 模式清空）
6. 渲染任务指令
7. 组装 baseMessages
8. 追加调用指令（**问题所在**）
9. 生成最终 messagesFC

**核心问题**：步骤7和8分别生成了两条 user 消息，应合并为一条。
