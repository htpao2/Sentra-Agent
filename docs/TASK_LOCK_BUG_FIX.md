# 任务锁定机制 Bug 修复

## 🐛 问题描述

**症状**：
1. 修改后一直重复回复
2. 锁定机制失效
3. 队列超时，任务等待 932秒（15分钟以上）
4. 日志显示：`队列超时: 任务 064b4b05... 等待932459ms，已放弃`

## 🔍 根本原因

### 重复定义 `activeTasks`

**Main.js L294**：
```javascript
// ❌ 错误：Main.js 定义了自己的 activeTasks
const activeTasks = new Map();
```

**replyPolicy.js L22**：
```javascript
// ✅ 正确：replyPolicy.js 中的统一管理
const activeTasks = new Map();
```

**结果**：两个完全独立的 Map，状态不同步！

### 数据流分析

```
消息到达
  ↓
shouldReply() 
  → replyPolicy.activeTasks.add(taskId)  ✅ 正确添加
  ↓
handleOneMessage(taskId)
  ↓
finally {
  Main.activeTasks.get(userid)  ❌ 检查错误的 Map
  → 发现不存在，不清理
  ↓
  completeTask(taskId)
    → replyPolicy.activeTasks.delete(taskId)  ✅ 正确删除
}
```

### 问题链

1. **锁未释放**：
   - Main.js L691-694 检查的是**自己的 activeTasks**
   - 而实际锁在 **replyPolicy.activeTasks** 中
   - 导致 Main.js 误以为任务没完成

2. **队列积压**：
   - 由于锁未正确释放
   - 新消息不断进入队列
   - 队列任务等待时间超过 30 秒超时
   - 最终等待 932 秒（15 分钟）后放弃

3. **重复回复**：
   - 锁定机制失效
   - 多个任务同时执行
   - 导致重复回复

## ✅ 修复方案

### 1. 移除 Main.js 中的重复定义和所有引用

**修改位置**：
1. **L292-312**：删除 `activeTasks` 定义和定时清理代码
2. **L426**：删除注册任务代码 `activeTasks.set(userid, ...)`
3. **L507-521**：删除Judge阶段的新任务检测逻辑
4. **L759-762**：删除消息接收时的任务跟踪代码

**修改前**（4处使用 activeTasks）：
```javascript
// L294: 定义
const activeTasks = new Map();

// L426: 注册任务
activeTasks.set(userid, { taskId: currentTaskId, timestamp: Date.now() });

// L507: 检查新任务
const activeTask = activeTasks.get(userid);
const hasNewTask = activeTask && activeTask.taskId !== currentTaskId;

// L760: 更新任务
activeTasks.set(userid, { taskId, timestamp: Date.now() });
```

**修改后**（全部删除）：
```javascript
// ✅ L292-293: 只保留注释说明
// 注意：任务跟踪使用 replyPolicy.js 中的统一管理
// 不要在这里重复定义 activeTasks，避免状态不一致

// ✅ L423: 不再注册任务
const initialMessageCount = senderMessages.length;

// ✅ L502-504: 简化逻辑，只记录补充消息
if (latestSenderMessages.length > initialMessageCount) {
  logger.info(`动态感知Judge: ${groupId} 检测到补充消息 ...`);
}

// ✅ L736-738: 不再更新任务跟踪
const replyDecision = await shouldReply(msg);
const taskId = replyDecision.taskId;
logger.info(`回复决策: ${replyDecision.reason} ...`);
```

### 2. 移除错误的检查逻辑

**修改前**（Main.js L621-639）：
```javascript
// ❌ 错误：检查自己的 activeTasks
const activeTask = activeTasks.get(userid);
const hasNewTask = activeTask && activeTask.taskId !== currentTaskId && activeTask.timestamp > Date.now() - 60000;

if (hasNewTask) {
  logger.warn(`动态感知ToolResult发送前: ${groupId} 检测到新任务 ...`);
  // ...
  return;
}
```

**修改后**（Main.js L602-605）：
```javascript
// ✅ 正确：简化逻辑，移除错误的检查
const latestSenderMessages = getAllSenderMessages();
if (latestSenderMessages.length > initialMessageCount) {
  logger.info(`动态感知ToolResult: ${groupId} 检测到补充消息 ...`);
}
```

### 3. 简化 finally 清理逻辑

**修改前**（Main.js L690-709）：
```javascript
// ❌ 错误：手动检查并清理 activeTasks
const activeTask = activeTasks.get(userid);
if (activeTask && activeTask.taskId === currentTaskId) {
  activeTasks.delete(userid);
  logger.debug(`任务跟踪清理: ${userid} 任务 ${currentTaskId} 已完成`);
}

if (taskId && userid) {
  const next = await completeTask(userid, taskId);
  // ...
}
```

**修改后**（Main.js L656-668）：
```javascript
// ✅ 正确：completeTask 会自动调用 removeActiveTask
// 任务完成，释放并发槽位并尝试拉起队列中的下一条
// completeTask 会自动调用 replyPolicy.js 中的 removeActiveTask
if (taskId && userid) {
  const next = await completeTask(userid, taskId);
  if (next && next.msg) {
    const nextUserId = String(next.msg?.sender_id ?? '');
    const bundledNext = await collectBundle(nextUserId, next.msg);
    await handleOneMessage(bundledNext, next.id);
  }
}
```

## 🎯 修复效果

### 修复前
```
15:11:00 [DEBUG] [ReplyPolicy] 任务完成: sender=474764004, task=edbb0acf...
15:11:00 [WARN] [ReplyPolicy] 队列超时: 任务 064b4b05... 等待932459ms，已放弃
```

**问题**：
- 队列超时 932 秒（15 分钟）
- 锁未释放，任务积压
- 重复回复

### 修复后
```
[DEBUG] [ReplyPolicy] 活跃任务+: 474764004 添加任务 edbb0acf, 当前活跃数: 1
[INFO] [ReplyPolicy] 智能回复通过: 概率 75.2% >= 阈值 65.0%, task=edbb0acf
[DEBUG] [ReplyPolicy] 活跃任务-: 474764004 移除任务 edbb0acf, 剩余活跃数: 0
[DEBUG] [ReplyPolicy] 任务完成: sender=474764004, task=edbb0acf
```

**效果**：
- ✅ 锁正确释放
- ✅ 队列正常运行
- ✅ 不再重复回复
- ✅ 超时时间正常（<30 秒）

## 📊 核心原则

### 1. 单一职责原则
**replyPolicy.js** 负责：
- 管理所有任务锁（`activeTasks`）
- 添加/移除活跃任务
- 队列管理
- 并发控制

**Main.js** 负责：
- 调用 `shouldReply()` 获取 taskId
- 处理消息
- 调用 `completeTask()` 释放锁

### 2. 避免状态重复
- ❌ 不要在多个地方定义相同的状态变量
- ✅ 统一由一个模块管理
- ✅ 其他模块通过函数调用访问

### 3. 清晰的边界
```javascript
// replyPolicy.js - 内部状态
const activeTasks = new Map();  // ✅ 私有状态

// replyPolicy.js - 对外接口
export async function shouldReply(msg) { ... }  // 添加任务
export async function completeTask(senderId, taskId) { ... }  // 完成任务

// Main.js - 调用接口
const decision = await shouldReply(msg);  // 获取 taskId
await completeTask(userid, decision.taskId);  // 释放锁
```

## 🧪 测试方法

### 场景 1：快速连续消息
```
用户发送：
- 消息1 (0s)
- 消息2 (1s)
- 消息3 (2s)
```

**预期行为**：
- 第一条触发回复
- 后续进入队列
- 任务完成后依次处理
- 队列超时 < 30 秒

### 场景 2：并发控制
```
用户 A 发送消息 → 正在处理（taskId=xxx）
用户 A 又发送消息 → 进入队列
```

**预期行为**：
- 第一条任务执行中
- 第二条等待队列
- 第一条完成后自动拉起第二条
- `activeTasks.size` 始终 ≤ 1

### 场景 3：锁释放验证
```javascript
// 发送消息前
console.log(getActiveTaskCount(userId));  // 0

// 消息处理中
console.log(getActiveTaskCount(userId));  // 1

// 消息处理完成
console.log(getActiveTaskCount(userId));  // 0  ✅ 正确释放
```

## 📝 相关文件

### 修改的文件
- `Main.js`：
  - L292-293: 移除重复的 `activeTasks` 定义
  - L602-605: 简化动态感知逻辑
  - L656-668: 简化 finally 清理逻辑

### 未修改的文件
- `utils/replyPolicy.js`：保持不变，原本就是正确的

## ⚠️ 注意事项

### 1. 不要重复定义状态
```javascript
// ❌ 错误示例
// File A
const activeTasks = new Map();

// File B
const activeTasks = new Map();  // ❌ 重复定义，状态不一致
```

### 2. 使用导出的函数
```javascript
// ✅ 正确示例
// replyPolicy.js
const activeTasks = new Map();  // 私有
export function addActiveTask(id) { ... }  // 公开接口

// Main.js
import { addActiveTask } from './replyPolicy.js';
addActiveTask(taskId);  // ✅ 通过接口访问
```

### 3. 清晰的命名
如果确实需要不同的任务跟踪，使用不同的名称：
```javascript
// replyPolicy.js
const concurrencyLocks = new Map();  // 并发锁

// Main.js
const taskMetadata = new Map();  // 任务元数据
```

## 🎓 经验总结

1. **状态管理要集中**：
   - 一个状态只在一个地方管理
   - 其他地方通过函数访问

2. **避免同名变量**：
   - 同名变量容易混淆
   - 使用 ESLint 检测重复定义

3. **清晰的日志**：
   - 日志中明确显示来源模块
   - 方便定位状态不一致问题

4. **单元测试**：
   - 测试锁的添加/释放
   - 测试队列超时逻辑
   - 测试并发控制

---

**修复日期**：2024-11-10  
**Bug 等级**：严重（导致系统功能失效）  
**影响范围**：所有使用任务队列的消息处理  
**修复状态**：✅ 已完成
