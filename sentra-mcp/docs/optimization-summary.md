# Plan & Tool 优化总结

## 本次优化内容

### 1. ✅ Plan Reason 字段优化

**问题**: reason 字段包含具体结果预测，与实际执行结果不符

**解决方案**: 
- 优化 schema description，明确说明不要包含结果预测
- 优化 prompt 模板，提供正反示例
- 强调"说明为什么调用"而非"预测会得到什么"

**修改文件**:
- `src/agent/tools/internal/emit_plan.schema.json`
- `src/agent/prompts/emit_plan.json`
- `src/agent/prompts/fc_plan_sentra.json`

**对比示例**:
```diff
- "reason": ["分析图片内容以便确定合适的表情", "获取三个最能表达图片情绪的QQ表情ID"]
+ "reason": ["识别图片内容和主题", "分析图片情绪特征"]
```

---

### 2. ✅ Plan Overview 字段优化

**优化**: 增加 description 说明和编写指导

**原则**: 简洁说明任务总体目标，避免详细步骤描述

**对比示例**:
```diff
- "overview": "第一步识别图片，第二步选择表情，第三步回复群聊"
+ "overview": "分析用户消息内容，识别需求后调用工具完成任务"
```

---

### 3. ✅ Plan NextStep 字段优化

**优化**: 增加 description 说明和编写指导

**原则**: 描述如何使用结果，避免预测具体数据

**对比示例**:
```diff
- "nextStep": "使用返回的76,66,356这三个表情ID"
+ "nextStep": "根据识别结果选择合适的表情并贴到消息上"
```

---

### 4. ✅ 修复 draftArgs 未定义错误

**问题**: `fixToolArgs` 纠错时报错 "draftArgs is not defined"

**解决方案**:
- `planners.js`: 调用 `fixToolArgs` 时传入 `draftArgs` 参数
- `arggen.js`: 函数参数解构中添加 `draftArgs`

**修改文件**:
- `src/agent/planners.js` (L671)
- `src/agent/stages/arggen.js` (L436)

---

### 5. ✅ 修复 message_id oneOf 验证问题

**问题**: oneOf 同时匹配 string 和 integer，验证失败

**解决方案**: 简化为 `string + pattern`，利用 AJV 的 `coerceTypes` 自动转换

**修改文件**:
- `plugins/qq_message_emojiLike/config.json`

**Schema 变化**:
```diff
- "message_id": {
-   "oneOf": [
-     {"type": "string", "pattern": "^[0-9]+$"},
-     {"type": "integer", "minimum": 1}
-   ]
- }
+ "message_id": {
+   "type": "string",
+   "pattern": "^[0-9]+$"
+ }
```

---

### 6. 📋 工具 Description 编写指南

**新增文档**: `docs/tool-description-guidelines.md`

**核心原则**: 描述"能做什么"（功能），而非"会返回什么"（结果）

**快速对比**:

| 类型 | ❌ 错误 | ✅ 正确 |
|------|---------|---------|
| 图片识别 | "识别图片，返回详细描述和3个表情ID" | "读取并描述图片内容" |
| 网络搜索 | "搜索网页，返回10条结果" | "实时网络搜索，快速获取最新信息" |
| 文件操作 | "读取文件，返回UTF-8文本" | "读取文件内容，支持多种编码" |

---

## 文档资源

### 主要文档

1. **Plan Reason 优化详解**
   - 文件: `docs/plan-reason-optimization.md`
   - 内容: reason/overview/nextStep 字段的详细编写指南

2. **工具 Description 编写指南**
   - 文件: `docs/tool-description-guidelines.md`
   - 内容: 工具描述的最佳实践和示例

3. **优化总结**
   - 文件: `docs/optimization-summary.md` (本文档)
   - 内容: 所有优化项目的快速索引

### 关键 Schema 和 Prompt

- `src/agent/tools/internal/emit_plan.schema.json` - Plan 结构定义
- `src/agent/prompts/emit_plan.json` - 标准模式 prompt
- `src/agent/prompts/fc_plan_sentra.json` - FC 模式 prompt

---

## 使用效果

### Plan 阶段输出优化

**优化前**:
```json
{
  "overview": "使用image_vision_read识别图片，然后用qq_message_emojiLike贴表情",
  "steps": [{
    "aiName": "local__image_vision_read",
    "reason": ["分析引用的图片内容，以便确定合适的表情", "获取三个最能表达图片情绪的QQ表情ID"],
    "nextStep": "使用返回的76,66,356这三个表情ID贴到消息上"
  }]
}
```

**优化后**:
```json
{
  "overview": "分析图片内容，根据情绪选择表情并回复群聊",
  "steps": [{
    "aiName": "local__image_vision_read",
    "reason": ["识别图片内容和主题", "分析图片情绪特征"],
    "nextStep": "根据识别结果选择合适的表情并贴到消息上"
  }]
}
```

### 优势

1. **准确性**: reason 不再包含错误的结果预测
2. **可读性**: 日志和用户反馈更清晰
3. **灵活性**: 不受具体结果限制，适应性更强
4. **一致性**: 统一的编写规范，团队协作更顺畅

---

## 自检清单

### Plan 生成时检查

编写 plan 时，确保：

- [ ] **reason**: 数组格式，描述调用理由而非结果预测
- [ ] **overview**: 简洁的总体目标，避免详细步骤
- [ ] **nextStep**: 描述如何使用结果，避免具体数据预测
- [ ] **draftArgs**: 包含所有必填字段

### 工具开发时检查

开发工具时，确保：

- [ ] **description**: 描述功能而非结果
- [ ] **meta.realWorldAction**: 简短的用户友好说明
- [ ] **meta.responseExample**: 典型返回示例
- [ ] **inputSchema**: 参数有清晰的 description

---

## 待优化项目（可选）

### 低优先级优化

1. **现有工具 description 批量优化**
   - 优先级: 低
   - 工作量: 中等
   - 影响: 提高 AI 理解准确性

2. **工具 meta 字段标准化**
   - 优先级: 低
   - 工作量: 小
   - 影响: 统一工具元数据格式

3. **错误消息优化**
   - 优先级: 低
   - 工作量: 小
   - 影响: 提高调试效率

---

## 测试建议

### 回归测试场景

1. **图片识别 + 表情回应**
   - 输入: 用户发送图片消息
   - 预期: Plan 的 reason 不包含"获取X个表情ID"
   - 验证: 实际执行成功，选择合适表情

2. **网络搜索 + 总结**
   - 输入: "搜索最新的AI新闻"
   - 预期: reason 不包含"返回10条结果"
   - 验证: 搜索成功，总结合理

3. **文件操作 + 数据处理**
   - 输入: "读取配置文件并修改"
   - 预期: nextStep 不包含"解析JSON的某个字段"
   - 验证: 文件读写成功

### 监控指标

- **Plan 生成成功率**: 应保持不变或提高
- **参数验证通过率**: 应提高（修复 draftArgs 和 message_id 问题）
- **用户满意度**: reason 更合理，用户理解更清晰

---

## 相关 Issue 和 PR

- Fix: draftArgs 未定义导致纠错失败
- Fix: message_id oneOf 验证问题
- Optimize: Plan reason 字段不再包含结果预测
- Docs: 新增 Plan 和 Tool 编写指南

---

## 联系和反馈

如有问题或建议，请参考：
- `docs/plan-reason-optimization.md` - 详细优化文档
- `docs/tool-description-guidelines.md` - 工具描述指南
- 项目 Issue 跟踪系统

---

**优化完成时间**: 2025-11-05  
**优化版本**: v1.0  
**下次审查**: 建议在实际使用中收集反馈后进行
