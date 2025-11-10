# 用户画像更新逻辑优化

## 问题描述

**原有问题**：画像更新机制仅基于消息数量，导致用户连续发送多条消息时会触发多次更新。

**日志示例**：
```
14:28:31 [INFO] [PersonaManager] [画像] 474764004 达到 10 条消息，触发画像更新
14:28:31 [INFO] [PersonaManager] [画像] 开始分析用户画像 (474764004)...
14:28:32 [INFO] [PersonaManager] [画像] 474764004 达到 11 条消息，触发画像更新
14:28:32 [INFO] [PersonaManager] [画像] 开始分析用户画像 (474764004)...
```

**根本原因**：
1. 旧逻辑：`messagesSinceUpdate >= this.updateInterval`（仅检查消息数）
2. 用户连续发送第 10、11 条消息时，每条都满足条件
3. 没有时间间隔控制，没有防重机制

---

## 优化方案

### 核心改进

**新逻辑：基于时间间隔 + 消息阈值的双重控制**

1. **时间间隔控制**：距离上次更新必须超过指定时间（默认 10 分钟）
2. **消息阈值控制**：距离上次更新必须积累足够消息（默认 10 条）
3. **防重机制**：同一用户同一时间只能有一个待执行的更新任务

### 触发条件

**同时满足以下 3 个条件才触发更新**：

| 条件 | 说明 | 默认值 |
|------|------|--------|
| **时间间隔** | `now - lastUpdateTime >= updateIntervalMs` | 600000ms (10分钟) |
| **消息阈值** | `messagesSinceUpdate >= minMessagesForUpdate` | 10 条 |
| **无重复任务** | `!pendingUpdates.has(senderId)` | - |

---

## 数据结构变更

### UserData 新增字段

```javascript
{
  senderId: string,
  persona: string | null,
  messages: Array,
  messageCount: number,
  lastUpdateCount: number,
  lastUpdateTime: number | null,  // ✅ 新增：上次更新的时间戳（毫秒）
  createdAt: string,
  updatedAt: string,
  version: number
}
```

### 新增实例字段

```javascript
class UserPersonaManager {
  constructor(options) {
    // 时间间隔控制（毫秒）
    this.updateIntervalMs = 600000; // 10分钟
    
    // 消息阈值
    this.minMessagesForUpdate = 10;
    
    // 防重标记
    this.pendingUpdates = new Set(); // sender_id
  }
}
```

---

## 配置参数

### 环境变量

```bash
# 画像更新时间间隔（毫秒）- 默认 600000 (10分钟)
PERSONA_UPDATE_INTERVAL_MS=600000

# 画像更新消息阈值 - 默认 10 条
PERSONA_MIN_MESSAGES=10
```

### 场景配置建议

| 场景 | `PERSONA_UPDATE_INTERVAL_MS` | `PERSONA_MIN_MESSAGES` | 说明 |
|------|------------------------------|------------------------|------|
| **活跃群聊** | 600000 (10分钟) | 10 条 | 平衡更新频率和成本 |
| **低频对话** | 1800000 (30分钟) | 5 条 | 消息少，降低阈值 |
| **高频对话** | 300000 (5分钟) | 20 条 | 缩短间隔，提高阈值 |
| **测试/开发** | 60000 (1分钟) | 3 条 | 快速验证 |

---

## 核心逻辑实现

### 1. 检查并调度更新 (`_checkAndScheduleUpdate`)

```javascript
_checkAndScheduleUpdate(senderId, userData) {
  // 1. 防重检查
  if (this.pendingUpdates.has(senderId)) {
    logger.debug(`[画像] ${senderId} 已有待执行的更新，跳过`);
    return;
  }

  // 2. 检查消息阈值
  const messagesSinceUpdate = userData.messageCount - userData.lastUpdateCount;
  if (messagesSinceUpdate < this.minMessagesForUpdate) {
    logger.debug(`[画像] ${senderId} 新增消息数 ${messagesSinceUpdate} < 阈值 ${this.minMessagesForUpdate}，跳过`);
    return;
  }

  // 3. 检查时间间隔
  const now = Date.now();
  const lastUpdateTime = userData.lastUpdateTime || 0;
  const timeSinceUpdate = now - lastUpdateTime;
  
  if (timeSinceUpdate < this.updateIntervalMs) {
    const remainingMinutes = Math.ceil((this.updateIntervalMs - timeSinceUpdate) / 60000);
    logger.debug(`[画像] ${senderId} 距离上次更新仅 ${Math.floor(timeSinceUpdate / 60000)} 分钟，需等待 ${remainingMinutes} 分钟`);
    return;
  }

  // 4. 满足条件，触发更新
  logger.info(`[画像] ${senderId} 触发更新 - 新增 ${messagesSinceUpdate} 条消息，距上次更新 ${Math.floor(timeSinceUpdate / 60000)} 分钟`);
  
  // 5. 标记为待执行
  this.pendingUpdates.add(senderId);
  
  // 6. 异步执行，不阻塞
  setImmediate(() => {
    this.updatePersona(senderId).catch(err => {
      logger.error(`[画像] ${senderId} 异步更新失败`, err);
    }).finally(() => {
      // 清除待执行标记
      this.pendingUpdates.delete(senderId);
    });
  });
}
```

### 2. 更新画像 (`updatePersona`)

```javascript
async updatePersona(senderId) {
  const userData = this._loadUserData(senderId);
  if (!userData || userData.messages.length === 0) return;

  try {
    logger.info(`[画像] 开始分析用户画像 (${senderId})...`);

    // LLM 分析逻辑...
    const newPersona = await this._analyzePersona(...);

    if (newPersona) {
      userData.persona = newPersona;
      userData.version++;
      userData.lastUpdateCount = userData.messageCount;
      userData.lastUpdateTime = Date.now(); // ✅ 记录更新时间
      
      this._saveUserData(senderId, userData);
      
      logger.info(`[画像] ${senderId} 画像更新成功 - 版本 ${userData.version}`);
    }
  } catch (error) {
    logger.error('画像更新失败', error);
  }
}
```

---

## 日志输出示例

### 优化前（问题）

```
[INFO] [PersonaManager] [画像] 474764004 达到 10 条消息，触发画像更新（异步）
[INFO] [PersonaManager] [画像] 开始分析用户画像 (474764004)...
[INFO] [PersonaManager] [画像] 474764004 达到 11 条消息，触发画像更新（异步）  ❌ 重复触发
[INFO] [PersonaManager] [画像] 开始分析用户画像 (474764004)...  ❌ 重复分析
```

### 优化后（正确）

```
[INFO] [PersonaManager] [画像] 474764004 触发更新 - 新增 10 条消息，距上次更新 12 分钟
[INFO] [PersonaManager] [画像] 开始分析用户画像 (474764004)...
[DEBUG] [PersonaManager] [画像] 474764004 已有待执行的更新，跳过  ✅ 防重生效
[INFO] [PersonaManager] [画像] 474764004 画像更新成功 - 版本 2

... 10分钟后，用户又发送了15条新消息 ...

[INFO] [PersonaManager] [画像] 474764004 触发更新 - 新增 15 条消息，距上次更新 10 分钟
[INFO] [PersonaManager] [画像] 开始分析用户画像 (474764004)...
[INFO] [PersonaManager] [画像] 474764004 画像更新成功 - 版本 3
```

---

## 修改文件清单

| 文件 | 修改内容 | 说明 |
|------|---------|------|
| `utils/userPersonaManager.js` | 重构更新逻辑 | 新增时间控制、防重机制 |
| `.env.example` | 更新配置说明 | 新增 `PERSONA_UPDATE_INTERVAL_MS` 和 `PERSONA_MIN_MESSAGES` |
| `docs/PERSONA_UPDATE_OPTIMIZATION.md` | 文档 | 本文档 |

---

## 迁移指南

### 旧配置（已废弃）

```bash
# 旧版：基于消息数（不推荐）
PERSONA_UPDATE_INTERVAL=10
```

### 新配置（推荐）

```bash
# 新版：基于时间间隔 + 消息阈值
PERSONA_UPDATE_INTERVAL_MS=600000  # 10分钟
PERSONA_MIN_MESSAGES=10            # 至少10条新消息
```

### 数据迁移

**无需手动迁移**！旧用户数据会自动兼容：

- `lastUpdateTime` 字段不存在时，默认为 `0`
- 首次更新会记录 `lastUpdateTime = Date.now()`
- 后续更新正常按新逻辑执行

---

## 优势总结

| 优势 | 说明 |
|------|------|
| ✅ **防止频繁触发** | 时间间隔控制，避免短时间内多次更新 |
| ✅ **避免无意义更新** | 消息阈值控制，少量消息不触发 |
| ✅ **防重机制** | 同一用户同一时间只能有一个更新任务 |
| ✅ **成本优化** | 减少不必要的 LLM 调用 |
| ✅ **灵活配置** | 环境变量可根据场景调整 |
| ✅ **向后兼容** | 旧数据自动迁移，无需手动处理 |

---

## 测试验证

### 场景 1：连续消息

**输入**：用户在 1 分钟内连续发送 10 条消息

**预期**：
```
[INFO] [PersonaManager] [画像] 123456 触发更新 - 新增 10 条消息，距上次更新 15 分钟
[DEBUG] [PersonaManager] [画像] 123456 已有待执行的更新，跳过  ← 后续消息跳过
```

### 场景 2：时间间隔不足

**输入**：用户在 5 分钟内发送 20 条消息（上次更新在 3 分钟前）

**预期**：
```
[DEBUG] [PersonaManager] [画像] 123456 距离上次更新仅 3 分钟，需等待 7 分钟
```

### 场景 3：消息数不足

**输入**：用户在 20 分钟内发送 5 条消息（阈值 10）

**预期**：
```
[DEBUG] [PersonaManager] [画像] 123456 新增消息数 5 < 阈值 10，跳过
```

### 场景 4：正常触发

**输入**：用户在 15 分钟内发送 12 条消息

**预期**：
```
[INFO] [PersonaManager] [画像] 123456 触发更新 - 新增 12 条消息，距上次更新 15 分钟
[INFO] [PersonaManager] [画像] 开始分析用户画像 (123456)...
[INFO] [PersonaManager] [画像] 123456 画像更新成功 - 版本 3
```

---

## 常见问题

### Q1: 为什么需要时间间隔控制？

**A**: 防止短时间内频繁调用 LLM，节省成本。用户连续发送多条消息时，画像不会立刻变化，无需每次都更新。

### Q2: 为什么需要消息阈值？

**A**: 避免无意义的更新。如果用户只发送了 1-2 条消息，画像分析的结果可能与上次几乎一致，浪费 LLM 调用。

### Q3: 如果用户很久没发消息，画像会更新吗？

**A**: 不会。只有同时满足"时间间隔"和"消息阈值"才触发。如果用户 1 小时后才发 1 条消息，虽然时间足够，但消息数不足，不会触发。

### Q4: 如何快速测试画像更新？

**A**: 修改 `.env`：
```bash
PERSONA_UPDATE_INTERVAL_MS=60000  # 1分钟
PERSONA_MIN_MESSAGES=3            # 3条消息
```

重启应用，发送 3 条消息，等待 1 分钟后再发送，即可触发更新。

---

## 相关文档

- `utils/userPersonaManager.js` - 画像管理器实现
- `.env.example` - 环境变量配置示例
- `Main.js` - 画像管理器初始化
