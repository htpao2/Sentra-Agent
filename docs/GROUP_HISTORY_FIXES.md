# 群聊历史记录管理修复文档

## 修复时间
2024-11-10

## 修复的问题

### 问题 1：不同用户的消息混淆导致不必要的回复跳过

**症状**：
- 用户A 发消息触发任务，Bot 开始处理
- 用户B 在处理过程中发消息
- Bot 在处理 A 的任务时，错误地将 B 的消息也包含在上下文中
- 导致 Bot 回复包含了 B 的消息内容，或者跳过回复

**根本原因**：
`getPendingMessagesContext(groupId)` 方法返回群内**所有人的待回复消息**，而不是特定 sender 的消息。

**数据流**：
```
1. 用户A 发消息 → addPendingMessage → pending队列
2. startProcessingMessages('A') → 将A的消息移到 processing队列
3. 用户B 发消息 → addPendingMessage → pending队列（新）
4. Bot处理A的任务，调用 getPendingMessagesContext(groupId)
5. ❌ 错误：返回 pending 中的所有消息（包括B的）
6. Bot 生成的上下文包含了 B 的消息 → 混淆
```

**修复方案**：
修改 `getPendingMessagesContext(groupId, senderId)` 方法：
- 新增可选参数 `senderId`
- 如果提供 `senderId`，只返回该发送者的历史消息
- 合并 `pendingMessages` 和 `processingMessages`，确保能看到正在处理的消息
- 除了最后一条消息，其他都作为历史上下文

**修改文件**：
- `utils/groupHistoryManager.js`: L289-350
  - 新增 `senderId` 参数
  - 过滤逻辑：`filter(pm => String(pm.msgObj.sender_id) === String(senderId))`
  - 合并待处理和正在处理的消息

- `Main.js`: L452, L528
  - 调用 `getPendingMessagesContext(groupId, userid)` 时传递 `userid`
  - 确保只获取当前处理的用户的历史上下文

### 问题 2：对话对保存跳过 - 没有 pairId

**症状**：
```
11:55:31 [WARN] [GroupHistory] 保存跳过: G:1047175021 没有pairId
```

**根本原因**：
1. **状态不一致**：`pairId` 在某些异步边界情况下可能已经被清空
2. **检查不严格**：`finishConversationPair` 没有严格验证所有必需字段
3. **日志不足**：无法追踪 `pairId` 的完整生命周期

**修复方案**：

#### 1. 增强 `finishConversationPair` 的状态检查
```javascript
// 严格检查三个必需字段
if (!pairId) {
  logger.warn(`保存跳过: ${groupId} 没有pairId (状态未初始化或已取消)`);
  return false;
}

if (!userContent || userContent.trim().length === 0) {
  logger.warn(`保存跳过: ${groupId} pairId ${pairId.substring(0, 8)} userContent为空`);
  // 清理不完整的状态
  history.currentPairId = null;
  history.currentAssistantMessage = '';
  return false;
}

if (!assistantMsg || assistantMsg.trim().length === 0) {
  logger.warn(`保存跳过: ${groupId} pairId ${pairId.substring(0, 8)} assistantMsg为空`);
  // 清理不完整的状态
  history.currentPairId = null;
  history.currentAssistantMessage = '';
  return false;
}
```

#### 2. 增强 pairId 生命周期日志

**pairId 的完整生命周期**：
```
创建：
- Judge 阶段：startAssistantMessage() → pairId
  日志: "创建pairId-Judge: G:xxx pairId abcd1234"
  
- ToolResult 阶段：startAssistantMessage() → pairId（如果之前没创建）
  日志: "创建pairId-ToolResult: G:xxx pairId abcd1234"

取消：
- AI响应失败：cancelConversationPairById()
  日志: "取消pairId-Judge失败: G:xxx pairId abcd1234"
  日志: "取消pairId-ToolResult失败: G:xxx pairId abcd1234"
  
- 检测到新消息：cancelCurrentAssistantMessage()
  日志: "取消pairId-新消息Judge: G:xxx pairId abcd1234"
  日志: "取消pairId-新消息: G:xxx pairId abcd1234"
  
- 任务取消：cancelConversationPairById()
  日志: "清理pairId: G:xxx pairId abcd1234"
  
- 异常处理：cancelConversationPairById()
  日志: "取消pairId-异常: G:xxx pairId abcd1234"

保存：
- Summary 阶段：finishConversationPair()
  日志: "保存对话对: G:xxx pairId abcd1234"
  成功: "保存成功: G:xxx pairId abcd1234 包含2条processing, 5/20组历史, 0条pending"
  失败: "保存失败: G:xxx pairId abcd1234 状态不一致"
```

#### 3. Main.js Summary 阶段的改进
```javascript
if (ev.type === 'summary') {
  logger.info('对话总结', ev.summary);
  
  if (isCancelled) {
    logger.info(`任务已取消: ${groupId} 跳过保存对话对Summary阶段`);
    if (pairId) {
      logger.debug(`清理pairId: ${groupId} pairId ${pairId?.substring(0, 8)}`);
      await historyManager.cancelConversationPairById(groupId, pairId);
      pairId = null;
    }
    break;
  }

  if (pairId) {
    logger.debug(`保存对话对: ${groupId} pairId ${pairId.substring(0, 8)}`);
    const saved = await historyManager.finishConversationPair(groupId, currentUserContent);
    if (!saved) {
      logger.warn(`保存失败: ${groupId} pairId ${pairId.substring(0, 8)} 状态不一致`);
    }
    pairId = null;
  } else {
    logger.warn(`跳过保存: ${groupId} pairId为null`);
  }
  break;
}
```

**修改文件**：
- `utils/groupHistoryManager.js`: L533-596
  - 严格的状态检查（3个必需字段）
  - 清理不完整状态的逻辑
  - 更详细的日志（info级别）

- `Main.js`: L440, L472, L488, L518, L559, L575, L597, L625
  - pairId 创建日志
  - pairId 取消日志（各种场景）
  - pairId 保存日志

## 测试建议

### 测试场景 1：不同用户的消息不混淆
```
1. 用户A 发消息："帮我搜索..."
2. Bot 开始处理（Judge/Plan/ArgGen...）
3. 用户B 在处理过程中发消息："你好"
4. 检查：Bot 回复 A 的消息时，不应包含 B 的内容
```

**预期日志**：
```
[DEBUG] 开始处理: G:xxx sender A 移动1条消息 pending(0) -> processing(1)
[DEBUG] 动态感知GET: G:xxx pending 1, processing 1
[DEBUG] 获取该 sender A 的历史上下文
[INFO] AI响应成功Judge: G:xxx
```

### 测试场景 2：对话对正常保存
```
1. 用户发消息："测试"
2. Bot 完成回复
3. 检查日志是否有 "保存成功"
```

**预期日志**：
```
[DEBUG] 创建pairId-Judge: G:xxx pairId abcd1234
[INFO] AI响应成功Judge: G:xxx
[DEBUG] 保存对话对: G:xxx pairId abcd1234
[INFO] 保存成功: G:xxx pairId abcd1234 包含1条processing, 6/20组历史, 0条pending
```

### 测试场景 3：检测到新消息时正确取消
```
1. 用户A 发消息："帮我..."
2. Bot 开始处理
3. 用户A 快速发送第二条消息："补充..."
4. 检查：Bot 应该取消第一条的回复，重新处理
```

**预期日志**：
```
[DEBUG] 创建pairId-Judge: G:xxx pairId abcd1234
[INFO] 动态感知Judge: G:xxx 检测到新消息，拼接完整上下文
[WARN] 动态感知Judge发送前: G:xxx 检测到新消息 1 -> 2，放弃当前回复
[DEBUG] 取消pairId-新消息Judge: G:xxx pairId abcd1234
```

## 性能影响

- ✅ 无性能影响：`getPendingMessagesContext` 只是增加了一次过滤操作（O(n)）
- ✅ 日志开销最小：只在关键路径添加 `debug` 级别日志
- ✅ 状态检查开销可忽略：只是简单的字符串判断

## 向后兼容性

- ✅ `getPendingMessagesContext(groupId)` 仍然可用（不传 senderId 参数）
- ✅ 返回所有人的历史上下文（旧行为）
- ✅ 新代码传递 `senderId` 参数，获得按用户过滤的上下文（新行为）

## 相关文档

- `utils/groupHistoryManager.README.md` - GroupHistoryManager 完整文档
- `docs/GROUP_HISTORY_UPDATE.md` - Sentra XML 协议集成文档
