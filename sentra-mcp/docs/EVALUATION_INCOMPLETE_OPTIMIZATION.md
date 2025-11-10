# Evaluation Incomplete 字段优化

## 🎯 优化目标

解决 evaluation 阶段 `success` 字段语义不明确导致 reflection 阶段无法正确触发的问题。

---

## ❌ 问题现象

### 问题案例
```javascript
{
  runId: '5c988abe-e8a8-4ab9-b909-8349ce6b8d00',
  type: 'evaluation',
  result: {
    success: true,  // ✅ 已执行步骤都成功
    failedSteps: [],
    summary: '已成功完成上海7日天气查询、3个TXT文件写入...。剩余步骤：将伪人图像渲染为恐怖谷HTML页面图片，并打包成桌面应用。'
    // ⚠️ summary 明确说"剩余步骤"，但 success=true 导致不会触发 reflection
  }
}
```

### 根本原因

**旧逻辑的语义混淆**：
- `success: true` 表示："已执行的步骤都成功了"
- 但**不能表示**："任务是否完整"

**导致的问题**：
```javascript
// 旧代码 L1337
const shouldReflect = config.flags.enableReflection && evalObj?.result?.success === false;
```
- 只有当 `success === false`（步骤失败）才触发 reflection
- 当所有步骤成功但**有遗漏操作**时，`success === true`，**不会触发 reflection**
- 导致任务不完整也被当作完成

---

## ✅ 优化方案

### 核心改进：分离两个独立维度

增加 `incomplete` 字段，明确区分：
1. **success**：已执行步骤是否成功（工具层面）
2. **incomplete**：任务是否有遗漏步骤（目标层面）

### 字段语义

| 字段 | 类型 | 含义 | 判断依据 |
|------|------|------|---------|
| **success** | boolean | 已执行步骤是否成功 | `res.success=true` 且结果合理 → true<br>任一步骤失败 → false |
| **incomplete** | boolean | 任务是否不完整（有遗漏） | 有计划步骤未执行 → true<br>用户目标未完全达成 → true<br>所有关键操作已执行 → false |

### 四种组合场景

| success | incomplete | 场景说明 | 示例 | 触发 Reflection |
|---------|-----------|---------|------|----------------|
| ✅ true | ❌ false | 完美完成 | 所有步骤成功且目标完整达成 | ❌ 否 |
| ✅ true | ⚠️ true | **步骤成功但有遗漏** | 生成了图片但未保存；查询了天气但未渲染为HTML | **✅ 是（关键）** |
| ❌ false | ⚠️ true | 步骤失败且不完整 | 某步骤失败且还有遗漏操作 | ✅ 是 |
| ❌ false | ❌ false | 步骤失败但无遗漏 | 该执行的都执行了，只是某步失败 | ❌ 否（可选） |

---

## 📝 修改内容

### 1. Schema 定义（final_judge.schema.json）

**新增字段**：
```json
{
  "incomplete": { 
    "type": "boolean",
    "description": "任务是否不完整（有遗漏步骤）：true=有计划中的步骤未执行或用户目标未完全达成，false=任务已完整执行所有必要步骤。这个字段独立于 success 判断。"
  }
}
```

**必填字段更新**：
```json
"required": ["success", "incomplete"]  // 新增 incomplete 为必填
```

---

### 2. 提示词优化（final_judge.json）

**新增 incomplete 判断指引**：
```
【incomplete 字段】判断"任务是否完整"：
1) 比对用户目标与已执行步骤，判断是否有遗漏的关键操作。
2) 如果目标中提到的某些操作未执行（如"生成图片"但没有调用图片生成工具），则 incomplete=true。
3) 如果计划中的步骤未全部执行（如 attempted < 计划步骤数），则 incomplete=true。
4) 只有当目标的所有关键操作均已执行时，才能 incomplete=false。
5) 如果目标超出工具能力范围，不据此判定 incomplete=true，应在 summary 中说明。

【示例】
- 所有步骤成功且目标完整达成：success=true, incomplete=false
- 所有步骤成功但还有遗漏操作：success=true, incomplete=true  ← 关键场景
- 有步骤失败：success=false, incomplete=true
```

---

### 3. 评估逻辑（evaluate.js）

**解析 incomplete 字段**（L103, L158）：
```javascript
// Native tools 模式
const incomplete = typeof args.incomplete === 'boolean' 
  ? args.incomplete 
  : (String(args.incomplete || '').toLowerCase() === 'true');

// FC 模式同样解析
result = { success: !!success, incomplete: !!incomplete, failedSteps, summary };
```

**默认值处理**（L177）：
```javascript
// 解析失败时的默认值
result = { success: true, incomplete: false };
```

---

### 4. Reflection 触发逻辑（planners.js）

**旧逻辑**（L1337，❌ 错误）：
```javascript
const shouldReflect = config.flags.enableReflection && evalObj?.result?.success === false;
// ❌ 只有步骤失败才触发，遗漏操作时不触发
```

**新逻辑**（L1337，✅ 正确）：
```javascript
const shouldReflect = config.flags.enableReflection && evalObj?.result?.incomplete === true;
// ✅ 基于 incomplete 判断，任务不完整时触发
```

**日志优化**（L1342-1360）：
```javascript
// 完整时跳过
logger.info('Reflection: evaluation 判定任务完整，跳过完整性检查', {
  evalSuccess: evalObj?.result?.success,
  evalIncomplete: false,
  evalSummary: evalObj?.result?.summary?.slice(0, 100)
});

// 不完整时触发
logger.info('Reflection: evaluation 判定任务不完整，开始完整性检查', {
  evalSuccess: evalObj?.result?.success,
  evalIncomplete: true,
  evalSummary: evalObj?.result?.summary?.slice(0, 200)
});
```

---

## 📊 优化前后对比

### 案例：生成图片未保存场景

#### 优化前
```javascript
// Evaluation 结果
{
  success: true,  // 步骤都成功
  summary: "已生成图片。剩余步骤：保存图片到本地"
}

// Planner 判断
shouldReflect = false  // ❌ success=true，不触发 reflection
// 结果：任务结束，图片未保存
```

#### 优化后
```javascript
// Evaluation 结果
{
  success: true,        // 步骤都成功
  incomplete: true,     // ✅ 但任务不完整
  summary: "已生成图片。剩余步骤：保存图片到本地"
}

// Planner 判断
shouldReflect = true   // ✅ incomplete=true，触发 reflection
// 结果：自动补充保存操作
```

---

### 案例：用户问题中的场景

#### 优化前
```javascript
{
  success: true,
  summary: "已成功完成上海7日天气查询、3个TXT文件写入、3个思维导图生成、紧急通知伪人恐怖图像绘制。剩余步骤：将伪人图像渲染为恐怖谷HTML页面图片，并打包成桌面应用。"
}
// ❌ success=true → 不触发 reflection → 任务结束 → 剩余步骤未执行
```

#### 优化后
```javascript
{
  success: true,        // 已执行步骤都成功
  incomplete: true,     // ✅ 但有剩余步骤
  summary: "已成功完成上海7日天气查询、3个TXT文件写入、3个思维导图生成、紧急通知伪人恐怖图像绘制。剩余步骤：将伪人图像渲染为恐怖谷HTML页面图片，并打包成桌面应用。"
}
// ✅ incomplete=true → 触发 reflection → 补充剩余步骤
```

---

## 🎨 字段设计哲学

### 为什么需要两个字段？

**success**（工具执行层面）：
- 问题：工具调用是否成功？
- 关注：res.success, 异常, 返回值合理性
- 适用于：已执行的步骤

**incomplete**（任务目标层面）：
- 问题：用户目标是否完整达成？
- 关注：计划步骤是否全部执行，目标是否有遗漏
- 适用于：整体任务

### 类比理解

假设用户要求："做10道菜"

| 情况 | success | incomplete | 说明 |
|------|---------|-----------|------|
| 做了10道，都成功 | ✅ true | ❌ false | 完美 |
| 做了5道，都成功 | ✅ true | ⚠️ **true** | **步骤成功但不完整** |
| 做了10道，有3道失败 | ❌ false | ⚠️ true | 步骤失败且可能需要重做 |
| 做了5道，有2道失败 | ❌ false | ⚠️ true | 又失败又不完整 |

---

## 🔍 关键点总结

### 1. 语义独立
- `success` 和 `incomplete` 是**两个独立维度**
- 不能用 `success` 代替 `incomplete` 的判断

### 2. Reflection 触发条件
```javascript
// ❌ 错误：基于 success
shouldReflect = evalObj?.result?.success === false

// ✅ 正确：基于 incomplete
shouldReflect = evalObj?.result?.incomplete === true
```

### 3. LLM 判断责任
- **success**：基于工具返回的 `res.success` 和结果合理性
- **incomplete**：基于用户目标与已执行步骤的对比

### 4. 向后兼容
- 如果 LLM 未输出 `incomplete`，默认按 `String(args.incomplete || '').toLowerCase() === 'true'` 处理
- 解析失败时默认 `{ success: true, incomplete: false }`

---

## 🚀 预期效果

### 1. 正确触发 Reflection
- 所有"步骤成功但有遗漏"的场景都会触发 reflection
- 自动补充遗漏的关键操作

### 2. 避免误判完成
- 不会因为 `success: true` 就认为任务完整
- 明确区分"步骤成功"与"任务完整"

### 3. 更精准的任务完成度评估
- evaluation 阶段给出明确的两维度判断
- reflection 阶段基于正确的维度触发

---

## 📋 修改文件清单

1. ✅ `src/agent/tools/internal/final_judge.schema.json`
   - 新增 `incomplete` 字段定义
   - 更新 `required` 数组
   - 添加字段说明

2. ✅ `src/agent/prompts/final_judge.json`
   - 更新 system 提示词
   - 明确 success 和 incomplete 的判断标准
   - 增加示例说明

3. ✅ `src/agent/stages/evaluate.js`
   - 解析 `incomplete` 字段（Native 和 FC 模式）
   - 更新 result 对象结构
   - 更新默认值

4. ✅ `src/agent/planners.js`
   - 修改 reflection 触发条件（L1337）
   - 更新日志信息（L1342-1360）
   - 使用 `incomplete` 而非 `success` 判断

---

## 🧪 测试建议

### 测试用例 1：步骤成功但有遗漏
```javascript
// 场景：生成图片但未保存
用户目标: "生成一张猫的图片并保存到 E:/cat.png"
已执行步骤: ["image_draw: 成功生成图片"]
预期 Evaluation: { success: true, incomplete: true }
预期行为: 触发 reflection，补充 write_file 操作
```

### 测试用例 2：所有步骤成功且完整
```javascript
// 场景：完整执行
用户目标: "查询北京天气"
已执行步骤: ["weather: 成功查询北京天气"]
预期 Evaluation: { success: true, incomplete: false }
预期行为: 不触发 reflection，直接进入 summary
```

### 测试用例 3：有步骤失败
```javascript
// 场景：步骤失败
用户目标: "读取文件 E:/data.txt 并分析"
已执行步骤: ["document_read: 失败（文件不存在）"]
预期 Evaluation: { success: false, incomplete: true }
预期行为: 触发 reflection（可选，取决于配置）
```

### 测试用例 4：用户问题场景
```javascript
// 场景：复杂任务部分完成
用户目标: "查询天气、生成TXT、生成思维导图、绘制图片、渲染HTML、打包应用"
已执行步骤: [前4个步骤成功]
预期 Evaluation: { 
  success: true,      // 已执行的都成功
  incomplete: true,   // 但还有2个步骤
  summary: "已完成...。剩余步骤：渲染HTML、打包应用"
}
预期行为: 触发 reflection，补充剩余2个步骤
```

---

## 💡 最佳实践

### LLM 输出建议

**完整任务**：
```xml
<sentra-tools>
  <invoke name="final_judge">
    <parameter name="success">true</parameter>
    <parameter name="incomplete">false</parameter>
    <parameter name="summary">已成功完成所有步骤：查询天气、生成报告、发送通知。用户目标已完全达成。</parameter>
  </invoke>
</sentra-tools>
```

**步骤成功但有遗漏**：
```xml
<sentra-tools>
  <invoke name="final_judge">
    <parameter name="success">true</parameter>
    <parameter name="incomplete">true</parameter>
    <parameter name="summary">已成功生成图片和思维导图。但用户要求将图片渲染为HTML页面并打包成应用，这两个步骤尚未执行。剩余步骤：web_render_image、html_to_app。</parameter>
  </invoke>
</sentra-tools>
```

**有步骤失败**：
```xml
<sentra-tools>
  <invoke name="final_judge">
    <parameter name="success">false</parameter>
    <parameter name="incomplete">true</parameter>
    <parameter name="failedSteps">[{"index": 2, "aiName": "document_read", "reason": "文件不存在"}]</parameter>
    <parameter name="summary">步骤2文件读取失败，后续分析无法进行。</parameter>
  </invoke>
</sentra-tools>
```

---

## 📚 相关文档

- `src/agent/stages/evaluate.js` - 评估阶段实现
- `src/agent/stages/reflection.js` - 反思阶段实现
- `src/agent/planners.js` - 规划器流程控制
- `docs/REFLECTION_MECHANISM.md` - Reflection 机制完整文档

---

## 🎉 总结

### 核心改进
- ✅ 增加 `incomplete` 字段，明确区分"步骤成功"与"任务完整"
- ✅ Reflection 基于 `incomplete` 触发，而非 `success`
- ✅ 解决"步骤成功但有遗漏"时无法补充的问题

### 预期效果
- 🚀 任务完成度评估更精准
- 🚀 自动补充遗漏操作更可靠
- 🚀 用户体验更好（不会漏掉关键步骤）

### 适用场景
- 所有使用 evaluation + reflection 的任务流程
- 特别适用于多步骤、复杂目标的场景
- 解决"做了一部分就认为完成"的问题
