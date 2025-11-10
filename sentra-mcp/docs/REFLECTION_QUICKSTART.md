# Reflection 机制快速上手

## 什么是 Reflection？

**Reflection（反思）机制**在任务总结前自动检查是否有遗漏的操作，并智能补充必要的步骤。

例如：
- ✅ 生成了图片 → 检测到未保存 → 自动保存到文件
- ✅ 搜索了信息 → 检测到未通知 → 自动发送通知
- ✅ 任务已完整 → 直接进入总结

## 快速启用

### 1. 环境变量配置（.env）

```bash
# 启用 Reflection（默认：true）
ENABLE_REFLECTION=true

# 最多补充几个操作（默认：3）
REFLECTION_MAX_SUPPLEMENTS=3

# Reflection 使用的模型（可选）
REFLECTION_FC_MODEL=gpt-4o-mini
```

### 2. 重启服务

```bash
# 重启 Sentra-MCP 服务
npm run dev
```

## 工作流程

```
执行完成 → Reflection 检查 → 发现遗漏？
                              ├─ 是 → 生成补充计划 → 执行补充 → 总结
                              └─ 否 → 直接总结
```

## 实际效果

### 示例 1：生成图片未保存

**任务**：设计两个伪人角色插画

**原执行**：
1. ✅ 生成图片 1（录像带女孩）
2. ✅ 生成图片 2（替代者）

**Reflection 检测**：
- ❌ 不完整：生成的图片未保存到文件
- 🔧 补充操作：保存图片到持久化文件

**补充执行**：
3. ✅ 保存图片 1 到 `/artifacts/girl.png`
4. ✅ 保存图片 2 到 `/artifacts/substitute.png`

**最终总结**：任务完整，生成并保存了两张插画

### 示例 2：任务已完整

**任务**：读取并解析配置文件

**原执行**：
1. ✅ 读取 `config.json`
2. ✅ 解析 JSON 内容

**Reflection 检测**：
- ✅ 完整：所有必要操作已执行
- 📝 无需补充

**最终总结**：任务完整，成功读取并解析配置

## 配置选项

### 基础配置

```bash
# 完全禁用 Reflection
ENABLE_REFLECTION=false

# 限制补充数量（避免过度补充）
REFLECTION_MAX_SUPPLEMENTS=1  # 最多补充 1 个操作
REFLECTION_MAX_SUPPLEMENTS=3  # 最多补充 3 个操作（默认）
REFLECTION_MAX_SUPPLEMENTS=5  # 最多补充 5 个操作
```

### 高级配置

```bash
# 使用更强的模型（提高判断准确性）
REFLECTION_FC_MODEL=gpt-4o

# 调整采样参数
FC_REFLECTION_TEMPERATURE=0.2  # 更确定性的判断
FC_REFLECTION_MAX_RETRIES=2    # 解析失败时的重试次数
```

## 查看日志

启用详细日志查看 Reflection 过程：

```bash
ENABLE_VERBOSE_STEPS=true
LOG_PRETTY_LABELS=PLAN,STEP,RESULT,REFLECTION
```

日志示例：

```
[REFLECTION] 完整性检查完成
  - isComplete: false
  - missingsCount: 1
  - supplementsCount: 1

[REFLECTION] 开始生成补充计划
  - supplements: ["保存生成结果"]

[REFLECTION] 补充执行完成
  - globalSucceeded: 4 (原 2 + 补充 2)
```

## 常见问题

### Q1: Reflection 会增加多少时间？

**A**: 
- 完整性检查：~2 秒
- 如果需要补充：额外 5-15 秒（取决于补充操作）
- 如果任务已完整：仅 2 秒

### Q2: 如何避免过度补充？

**A**: 
1. 设置合理的 `REFLECTION_MAX_SUPPLEMENTS`（推荐 1-3）
2. Reflection 内置了判断逻辑，只补充关键操作
3. 监控日志，如果补充过多可以调整提示词

### Q3: 可以禁用某些任务的 Reflection 吗？

**A**: 
目前是全局开关，但可以通过以下方式部分控制：
- 设置 `ENABLE_REFLECTION=false` 完全禁用
- 设置 `REFLECTION_MAX_SUPPLEMENTS=0` 仅检查但不补充（实验性）

### Q4: Reflection 会重复执行已完成的步骤吗？

**A**: 
不会。Reflection 继承之前的工具上下文，只补充遗漏的操作。

## 进阶使用

### 场景 1：生产环境

```bash
# 确保任务完整性
ENABLE_REFLECTION=true
REFLECTION_MAX_SUPPLEMENTS=3
REFLECTION_FC_MODEL=gpt-4o  # 使用更强模型
```

### 场景 2：开发测试

```bash
# 加快迭代速度
ENABLE_REFLECTION=false
```

### 场景 3：演示环境

```bash
# 展示系统智能
ENABLE_REFLECTION=true
REFLECTION_MAX_SUPPLEMENTS=5
ENABLE_VERBOSE_STEPS=true
```

## 更多信息

- 📖 完整文档：[REFLECTION_MECHANISM.md](./REFLECTION_MECHANISM.md)
- 🔬 学术基础：基于 [arXiv:2508.02744v1](https://arxiv.org/html/2508.02744v1) Global Reflection 最佳实践
- 💡 实现细节：查看 `src/agent/stages/reflection.js`

## 总结

Reflection 机制让 Sentra-MCP 更加智能和可靠，自动发现并补充遗漏的操作，确保任务完整性。通过简单的环境变量配置即可启用，推荐在生产环境中使用。
