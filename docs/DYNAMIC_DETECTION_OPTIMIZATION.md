# 动态感知逻辑优化文档

## 修改时间
2024-11-10

## 问题描述

### 原有逻辑的问题

**现象**：
```
13:42:05 [WARN] [Main] 动态感知ToolResult发送前: G:1047175021 检测到新消息 3 -> 4，放弃当前回复
```

**原有逻辑**：
1. 用户 A 发送消息 1，触发任务 1
2. Bot 开始处理任务 1
3. 用户 A 又发送消息 2
4. **检测到该用户消息数量增加** → 立刻放弃任务 1

**问题**：
- 消息 2 可能只是补充说明，**不会触发新任务**（`shouldReply` 返回 false）
- 但当前逻辑还是错误地放弃了任务 1
- 导致用户的补充消息被忽略，Bot 不回复

### 正确的逻辑应该是

**只有当用户触发了新的回复任务时，才应该放弃当前任务**

```
用户发消息 A → 任务 1 开始
用户发消息 B → 判断是否触发新任务：
  - 如果触发任务 2（shouldReply = true）→ 放弃任务 1
  - 如果不触发任务 2（shouldReply = false）→ 继续任务 1，整合消息 B 到上下文
```

## 优化方案

### 核心机制：任务跟踪 Map

```javascript
// 任务跟踪 Map: senderId -> { taskId, timestamp }
// 用于检测用户是否触发了新的回复任务
const activeTasks = new Map();
```

**记录规则**：
- 当 `shouldReply` 返回 true 且生成 taskId 时，记录该用户的活跃任务
- 每个用户只保留最新的任务记录
- 记录包含 `taskId` 和 `timestamp`

### 修改内容

#### 1. 入口处记录新任务

**位置**：`Main.js` 消息处理入口

```javascript
const replyDecision = await shouldReply(msg);
const taskId = replyDecision.taskId;

// 如果决定回复，更新活跃任务记录
if (replyDecision.needReply && taskId) {
  activeTasks.set(userid, { taskId, timestamp: Date.now() });
  logger.debug(`任务跟踪: ${userid} 触发新任务 ${taskId.substring(0, 8)}`);
}
```

#### 2. 任务开始时注册

**位置**：`handleOneMessage` 函数开始

```javascript
// 记录初始消息数量和当前任务ID
const initialMessageCount = senderMessages.length;
const currentTaskId = taskId;

// 注册当前任务
activeTasks.set(userid, { taskId: currentTaskId, timestamp: Date.now() });
```

#### 3. 检测新任务而非新消息

**位置**：Judge 和 ToolResult 发送前检查

**修改前**：
```javascript
const latestSenderMessages = getAllSenderMessages();
if (latestSenderMessages.length > initialMessageCount) {
  logger.warn(`动态感知发送前: 检测到新消息，放弃当前回复`);
  // 立刻放弃
}
```

**修改后**：
```javascript
const latestSenderMessages = getAllSenderMessages();
if (latestSenderMessages.length > initialMessageCount) {
  // 检查是否有新任务：只有当用户触发了新的回复任务时才放弃
  const activeTask = activeTasks.get(userid);
  const hasNewTask = activeTask 
    && activeTask.taskId !== currentTaskId 
    && activeTask.timestamp > Date.now() - 60000; // 1分钟内的新任务
  
  if (hasNewTask) {
    logger.warn(`动态感知发送前: 检测到新任务 (当前: ${currentTaskId?.substring(0,8)}, 新: ${activeTask.taskId?.substring(0,8)})，放弃当前回复`);
    // 放弃当前任务
  } else {
    logger.info(`动态感知: 检测到补充消息，整合到上下文`);
    // 继续处理，整合新消息
  }
}
```

**关键判断条件**：
1. `activeTask.taskId !== currentTaskId`：有不同的任务 ID
2. `activeTask.timestamp > Date.now() - 60000`：是最近 1 分钟内的新任务

#### 4. 任务完成时清理

**位置**：`handleOneMessage` 的 `finally` 块

```javascript
finally {
  // 清理任务跟踪记录（如果是当前任务）
  const activeTask = activeTasks.get(userid);
  if (activeTask && activeTask.taskId === currentTaskId) {
    activeTasks.delete(userid);
    logger.debug(`任务跟踪清理: ${userid} 任务 ${currentTaskId?.substring(0, 8)} 已完成`);
  }
  
  // ...其他清理逻辑
}
```

#### 5. 定期清理过期记录

**位置**：全局定时器

```javascript
// 定期清理过期的任务记录（每5分钟清理一次超过10分钟的记录）
setInterval(() => {
  const now = Date.now();
  const expireTime = 10 * 60 * 1000; // 10分钟
  let cleaned = 0;
  
  for (const [userId, task] of activeTasks.entries()) {
    if (now - task.timestamp > expireTime) {
      activeTasks.delete(userId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    logger.debug(`任务跟踪清理: 清理了 ${cleaned} 个过期任务记录`);
  }
}, 5 * 60 * 1000);
```

## 优化效果

### 场景 1：用户补充消息（不触发新任务）

**流程**：
1. 用户：`帮我查天气`（触发任务 1）
2. Bot：开始处理任务 1
3. 用户：`北京的`（补充，不触发新任务，`shouldReply = false`）
4. **新逻辑**：检测到没有新任务，继续处理任务 1，整合"北京的"到上下文
5. Bot：`北京今天晴，温度15-25℃`

**日志输出**：
```
[INFO] 动态感知Judge: G:xxx 检测到补充消息 1 -> 2，整合到上下文
```

### 场景 2：用户修正/新请求（触发新任务）

**流程**：
1. 用户：`帮我查天气`（触发任务 1）
2. Bot：开始处理任务 1
3. 用户：`不用了，帮我算个题`（触发任务 2，`shouldReply = true`）
4. **新逻辑**：检测到新任务 2，放弃任务 1
5. Bot：开始处理任务 2

**日志输出**：
```
[DEBUG] 任务跟踪: 123456 触发新任务 abc12345
[WARN] 动态感知Judge发送前: G:xxx 检测到新任务 (当前: xyz98765, 新: abc12345)，放弃当前回复
```

### 场景 3：群里其他人发消息

**流程**：
1. 用户 A：`帮我查天气`（触发任务 1）
2. Bot：开始处理任务 1
3. 用户 B：`今天吃什么`（其他用户消息）
4. **新逻辑**：`getAllSenderMessages()` 只返回用户 A 的消息，消息数不变，继续处理
5. Bot：正常回复用户 A

**优势**：群里其他人的消息不会影响当前任务

## 技术细节

### activeTasks Map 结构

```javascript
Map<string, { taskId: string, timestamp: number }>

// 示例
activeTasks = Map {
  '123456' => { taskId: 'abc-def-123', timestamp: 1699600000000 },
  '789012' => { taskId: 'xyz-789-456', timestamp: 1699600010000 }
}
```

### 新任务判断逻辑

```javascript
const hasNewTask = 
  activeTask &&                                    // 有活跃任务
  activeTask.taskId !== currentTaskId &&           // 任务ID不同
  activeTask.timestamp > Date.now() - 60000;       // 最近1分钟内
```

**为什么需要时间戳检查**？
- 防止旧的任务记录误判
- 如果任务记录超过 1 分钟，认为已过期，不影响当前任务

### 清理机制

**三个清理时机**：
1. **任务完成时**：如果是当前任务，立刻清理
2. **新任务触发时**：覆盖旧的任务记录
3. **定期清理**：每 5 分钟清理超过 10 分钟的记录

**防止内存泄漏**：
- 每个用户只保留一条记录（新任务覆盖旧任务）
- 定期清理过期记录
- 任务完成时清理记录

## 配置说明

### 可调整参数

```javascript
// 新任务判断的时间窗口（毫秒）
const NEW_TASK_WINDOW = 60000; // 1分钟

// 定期清理的间隔（毫秒）
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5分钟

// 过期时间（毫秒）
const EXPIRE_TIME = 10 * 60 * 1000; // 10分钟
```

### 调优建议

- **NEW_TASK_WINDOW**：
  - 太小：可能误判新任务为旧任务
  - 太大：可能误判旧任务为新任务
  - 推荐：60000（1分钟）

- **EXPIRE_TIME**：
  - 应该大于最长任务执行时间
  - 推荐：600000（10分钟）

## 测试验证

### 测试场景

#### 测试 1：补充消息

```
用户: 帮我查天气
(等待1秒)
用户: 北京的

预期: Bot 回复包含"北京"的天气信息
实际: ✅ 通过
```

#### 测试 2：修正请求

```
用户: 帮我查天气
(等待1秒)
用户: 不用了，算个题：1+1=?

预期: Bot 放弃天气查询，回复数学题答案
实际: ✅ 通过
```

#### 测试 3：群聊干扰

```
用户A: 帮我查天气
用户B: 今天吃什么
用户C: 我要睡觉了

预期: Bot 正常回复用户A的天气查询
实际: ✅ 通过
```

## 日志示例

### 正常流程

```
[INFO] 回复决策: 触发回复 (taskId=abc-123)
[DEBUG] 任务跟踪: 123456 触发新任务 abc-123
[INFO] 动态感知: G:xxx 检测到补充消息 1 -> 2，整合到上下文
[SUCCESS] AI响应成功Judge: G:xxx
[DEBUG] 任务跟踪清理: 123456 任务 abc-123 已完成
```

### 放弃任务

```
[INFO] 回复决策: 触发回复 (taskId=abc-123)
[DEBUG] 任务跟踪: 123456 触发新任务 abc-123
[INFO] 回复决策: 触发回复 (taskId=xyz-789)
[DEBUG] 任务跟踪: 123456 触发新任务 xyz-789
[WARN] 动态感知Judge发送前: G:xxx 检测到新任务 (当前: abc-123, 新: xyz-789)，放弃当前回复
```

## 常见问题

### Q1: 为什么不直接检查消息内容？

**A**: 消息内容无法准确判断是否触发新任务，因为：
- 需要运行完整的 `shouldReply` 逻辑
- `shouldReply` 包含欲望值、时间衰减等复杂计算
- 直接检查任务 ID 更简单、更可靠

### Q2: 如果两个任务几乎同时触发怎么办？

**A**: 
- `shouldReply` 是串行执行的（单线程 Node.js）
- 后触发的任务会覆盖前一个任务的记录
- 通过时间戳 + taskId 双重判断确保准确性

### Q3: activeTasks 会不会内存泄漏？

**A**: 不会，因为有三重清理机制：
1. 任务完成时清理
2. 新任务覆盖旧任务
3. 定期清理过期记录

最坏情况下，每个用户最多保留 1 条记录。

### Q4: 为什么需要 60 秒的时间窗口？

**A**:
- 防止任务记录未及时清理导致误判
- 1 分钟内的任务认为是"新任务"
- 超过 1 分钟的任务认为已过时，不影响当前任务

## 后续优化建议

### 优化 1：任务优先级

可以为不同类型的任务设置优先级：
```javascript
{
  taskId: 'abc-123',
  timestamp: Date.now(),
  priority: 'high' // 紧急任务
}
```

### 优化 2：任务队列可视化

添加日志或监控，显示：
- 当前活跃任务数量
- 每个用户的任务状态
- 任务放弃率

### 优化 3：智能判断

结合消息内容和时间间隔，更智能地判断是否应该放弃：
- 短时间内（<5秒）的消息认为是补充
- 长时间后（>30秒）的消息可能是新话题

## 相关文档

- `Main.js` - 主要修改文件
- `utils/replyPolicy.js` - `shouldReply` 实现
- `utils/groupHistoryManager.js` - 消息队列管理

## 版本历史

- **v1.0** (2024-11-10): 初始版本，基于任务 ID 的动态感知优化
