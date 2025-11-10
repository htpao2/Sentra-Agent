# Agent 配置说明文档

## 修改时间
2024-11-10

## 配置优化

### 问题描述

之前 agent.js 导出了一个默认实例，导致：
1. 环境变量配置可能在实例创建时还未加载
2. 无法灵活控制 Agent 实例的创建时机
3. 存在"兼容旧代码"的冗余导出

### 优化方案

1. **删除默认实例导出**
   - 移除 `export default defaultAgent`
   - 只导出 `Agent` 类
   - 由调用方显式创建实例

2. **Main.js 中创建 Agent 实例**
   - 在 Main.js 中显式创建 Agent 实例
   - 确保环境变量在实例创建前已加载
   - 传入完整配置参数

3. **UserPersonaManager 接收 agent 实例**
   - 不再导入默认 agent
   - 通过构造函数接收 agent 实例
   - 确保配置统一

## 配置文件说明

### .env.example 结构

```bash
# ===== AI API 配置 =====
# OpenAI 兼容 API 基础地址
API_BASE_URL=https://api.openai.com/v1

# API 密钥
API_KEY=your_api_key_here

# 默认模型名称（用于 Agent 类的默认配置）
MODEL_NAME=gpt-4o-mini

# 温度参数（0-2，越高越随机）
TEMPERATURE=0.7

# 最大 token 数（-1 表示不限制）
MAX_TOKENS=4096

# 最大重试次数（网络错误时）
MAX_RETRIES=3

# 请求超时时间（毫秒）
TIMEOUT=60000

# 主要对话使用的 AI 模型（用于处理用户消息的实际模型）
MAIN_AI_MODEL=gemini-2.5-flash-preview-09-2025
```

### 配置项说明

#### API_BASE_URL
- **作用**：OpenAI 兼容 API 的基础地址
- **默认值**：`https://api.openai.com/v1`
- **示例**：
  - OpenAI: `https://api.openai.com/v1`
  - 自定义代理: `https://your-proxy.com/v1`
  - 本地服务: `http://localhost:8000/v1`

#### API_KEY
- **作用**：API 访问密钥
- **必需**：是
- **获取方式**：从 API 提供商获取
- **注意**：不要将真实密钥提交到版本控制

#### MODEL_NAME
- **作用**：Agent 类的默认模型名称
- **默认值**：`gpt-4o-mini`
- **说明**：用于 Agent 实例的默认配置，可被 MAIN_AI_MODEL 覆盖

#### MAIN_AI_MODEL
- **作用**：Main.js 中实际使用的对话模型
- **默认值**：`gemini-2.5-flash-preview-09-2025`
- **说明**：这个配置用于主要的用户对话生成，优先级高于 MODEL_NAME
- **常用模型**：
  - `gpt-4o`
  - `gpt-4o-mini`
  - `gemini-2.5-flash-preview-09-2025`
  - `claude-3-5-sonnet-20241022`

#### TEMPERATURE
- **作用**：控制生成的随机性
- **范围**：0-2
- **默认值**：0.7
- **说明**：
  - 0：确定性输出，适合精确任务
  - 0.7：平衡创造性和准确性
  - 1.0+：更随机，适合创意任务

#### MAX_TOKENS
- **作用**：单次响应的最大 token 数
- **默认值**：4096
- **特殊值**：-1 表示不限制（由模型自行决定）
- **注意**：过大可能导致成本增加，过小可能截断回复

#### MAX_RETRIES
- **作用**：网络错误时的最大重试次数
- **默认值**：3
- **说明**：使用指数退避策略重试

#### TIMEOUT
- **作用**：API 请求超时时间（毫秒）
- **默认值**：60000（60秒）
- **说明**：根据网络情况和模型响应速度调整

## 使用方法

### 1. 创建配置文件

```bash
# 复制示例配置文件
cp .env.example .env

# 编辑配置文件
# 修改 API_KEY 为你的真实密钥
# 根据需要调整其他配置
```

### 2. 在代码中使用 Agent

```javascript
import { Agent } from './agent.js';

// 创建 Agent 实例（显式传入配置）
const agent = new Agent({
  apiKey: process.env.API_KEY,
  apiBaseUrl: process.env.API_BASE_URL,
  defaultModel: process.env.MODEL_NAME,
  temperature: parseFloat(process.env.TEMPERATURE || '0.7'),
  maxTokens: parseInt(process.env.MAX_TOKENS || '4096'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
  timeout: parseInt(process.env.TIMEOUT || '60000')
});

// 使用 agent
const response = await agent.chat(messages, {
  model: 'gpt-4o',  // 可以覆盖默认模型
  temperature: 0.5   // 可以覆盖默认温度
});
```

### 3. UserPersonaManager 使用

```javascript
import UserPersonaManager from './utils/userPersonaManager.js';

// 传入 agent 实例
const personaManager = new UserPersonaManager({
  agent: agent,  // 必需
  dataDir: './userData',
  updateInterval: 10,
  model: 'gpt-4o-mini'
});
```

## 配置优先级

Agent 类的配置优先级（从高到低）：

1. **方法调用时传入的参数**
   ```javascript
   await agent.chat(messages, { model: 'gpt-4o', temperature: 0.5 })
   ```

2. **Agent 实例化时传入的配置**
   ```javascript
   new Agent({ defaultModel: 'gpt-4o-mini', temperature: 0.7 })
   ```

3. **环境变量**
   ```bash
   API_KEY=xxx
   MODEL_NAME=gpt-4o-mini
   ```

4. **默认值**
   ```javascript
   defaultModel: 'gpt-3.5-turbo'
   temperature: 0.7
   ```

## 文件修改清单

### 1. agent.js
**改动**：
- 删除默认实例导出 `export default defaultAgent`
- 改为只导出 Agent 类
- 注释说明"由调用方创建实例"

### 2. Main.js
**改动**：
- 导入改为 `import { Agent } from './agent.js'`
- 在适当位置创建 Agent 实例
- 传入完整的环境变量配置
- 将 agent 实例传递给 personaManager

### 3. utils/userPersonaManager.js
**改动**：
- 移除 `import agent from '../agent.js'`
- 构造函数接收 `options.agent` 参数
- 添加必需参数检查
- 使用 `this.agent.chat()` 替代 `agent.chat()`

### 4. .env.example
**改动**：
- 添加分类注释（日志配置、WebSocket 配置、AI API 配置等）
- 为每个配置项添加详细说明
- 明确 MODEL_NAME 和 MAIN_AI_MODEL 的区别

## 配置验证

启动时会输出配置信息（敏感信息已脱敏）：

```
[Agent] Agent 初始化
  - API Base: https://api.openai.com/v1
  - Model: gpt-4o-mini
  - Temperature: 0.7
  - Max Tokens: 4096
  - Max Retries: 3
  - Timeout: 60000ms
```

## 常见问题

### Q1: 配置没有生效怎么办？

**检查步骤**：
1. 确认已创建 `.env` 文件（不是 `.env.example`）
2. 确认 `.env` 文件在项目根目录
3. 确认配置项名称拼写正确
4. 确认没有多余的空格或引号
5. 重启应用程序

### Q2: API_KEY 应该放哪里？

**答案**：
- 开发环境：放在 `.env` 文件中
- 生产环境：使用环境变量或密钥管理服务
- 绝对不要提交到 Git 仓库

### Q3: 为什么有 MODEL_NAME 和 MAIN_AI_MODEL 两个配置？

**答案**：
- `MODEL_NAME`：Agent 类的默认模型，用于各种通用场景
- `MAIN_AI_MODEL`：Main.js 中用户对话的实际模型，可以选择更强大的模型
- 这样可以在不同场景使用不同模型，平衡成本和效果

### Q4: MAX_TOKENS=-1 是什么意思？

**答案**：
- `-1` 表示不限制 token 数
- Agent 不会在请求中添加 `max_tokens` 字段
- 由模型自行决定响应长度
- 可能导致更长的响应和更高的成本

## 迁移指南

### 从旧版本迁移

如果你之前使用的是默认导出的 agent：

**旧代码**：
```javascript
import agent from './agent.js';
await agent.chat(messages);
```

**新代码**：
```javascript
import { Agent } from './agent.js';
const agent = new Agent({
  apiKey: process.env.API_KEY,
  apiBaseUrl: process.env.API_BASE_URL,
  // ...其他配置
});
await agent.chat(messages);
```

### 其他文件的迁移

如果其他文件也使用了 agent，需要：
1. 改为接收 agent 实例作为参数
2. 或者在该文件中创建自己的 Agent 实例
3. 不要再依赖默认导出

## 最佳实践

1. **统一配置源**：所有配置都从环境变量读取
2. **显式创建实例**：在应用入口处创建 Agent 实例
3. **传递实例**：通过构造函数或参数传递 agent 实例
4. **配置验证**：启动时输出配置信息，便于调试
5. **密钥安全**：不要将密钥提交到版本控制

## 相关文档

- `agent.js` - Agent 类实现
- `Main.js` - 应用入口，Agent 实例创建
- `utils/userPersonaManager.js` - 用户画像管理器
- `.env.example` - 配置文件示例
