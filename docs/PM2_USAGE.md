# PM2 进程管理指南

本项目使用 PM2 进行进程管理，确保 Sentra Agent 稳定运行、自动重启和日志记录。

## 快速开始

### 1. 安装 PM2（如果未安装）

```bash
npm install -g pm2
```

### 2. 启动服务

```bash
npm run pm2:start
```

## 常用命令

### 进程管理

| 命令 | 说明 |
|------|------|
| `npm run pm2:start` | 启动 Sentra Agent |
| `npm run pm2:stop` | 停止服务 |
| `npm run pm2:restart` | 重启服务（硬重启） |
| `npm run pm2:reload` | 重载服务（零停机时间） |
| `npm run pm2:delete` | 删除服务进程 |

### 监控和日志

| 命令 | 说明 |
|------|------|
| `npm run pm2:logs` | 查看实时日志 |
| `npm run pm2:monit` | 实时监控 CPU/内存 |
| `npm run pm2:status` | 查看服务状态 |

### 原生 PM2 命令（高级）

```bash
# 查看详细信息
pm2 describe sentra-agent

# 保存进程列表（开机自启）
pm2 save

# 生成开机自启脚本
pm2 startup

# 清空日志
pm2 flush

# 重置重启次数
pm2 reset sentra-agent
```

## 配置文件

配置文件位置：`ecosystem.config.cjs`

### 核心配置

```javascript
{
  name: 'sentra-agent',           // 进程名称
  script: './Main.js',             // 启动脚本
  instances: 1,                    // 实例数（1=单实例）
  exec_mode: 'fork',               // 执行模式
  max_memory_restart: '1G',        // 内存超过1GB自动重启
  autorestart: true,               // 自动重启
  watch: false,                    // 不监听文件变化（生产环境）
}
```

### 日志配置

- **错误日志**：`logs/pm2-error.log`
- **输出日志**：`logs/pm2-out.log`
- **日期格式**：`YYYY-MM-DD HH:mm:ss Z`

### 环境变量

```bash
# 生产环境（默认）
npm run pm2:start

# 开发环境
pm2 start ecosystem.config.cjs --env development
```

## 故障排查

### 1. 服务无法启动

```bash
# 查看错误日志
npm run pm2:logs

# 查看详细信息
pm2 describe sentra-agent
```

### 2. 内存占用过高

- 检查 `max_memory_restart` 配置
- 查看内存使用：`pm2 monit`
- 调整配置后重启：`npm run pm2:restart`

### 3. 频繁重启

- 检查 `min_uptime` 和 `max_restarts` 配置
- 查看错误日志：`npm run pm2:logs --err`
- 确认 `.env` 配置正确

### 4. 日志文件过大

```bash
# 清空日志
pm2 flush

# 或手动删除
rm -rf logs/pm2-*.log
```

## 开机自启

### Linux/macOS

```bash
# 1. 启动服务
npm run pm2:start

# 2. 保存进程列表
pm2 save

# 3. 生成自启脚本
pm2 startup

# 4. 执行提示的命令（sudo）
```

### Windows

使用 [pm2-windows-startup](https://www.npmjs.com/package/pm2-windows-startup)：

```bash
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

## 生产环境最佳实践

1. **使用 PM2 启动**：`npm run pm2:start`（而非 `npm start`）
2. **保存进程列表**：`pm2 save`（确保重启后自动恢复）
3. **定期检查状态**：`npm run pm2:status`
4. **监控资源使用**：`npm run pm2:monit`
5. **定期清理日志**：`pm2 flush`（避免日志文件过大）
6. **配置告警**：使用 [PM2 Plus](https://pm2.io/) 进行监控和告警

## 日常维护

### 每日检查

```bash
# 查看服务状态
npm run pm2:status

# 查看最近日志
npm run pm2:logs --lines 100
```

### 更新代码后

```bash
# 拉取最新代码
git pull

# 安装依赖（如果有更新）
npm install

# 重启服务
npm run pm2:restart
```

### 清理维护

```bash
# 清空日志
pm2 flush

# 重置重启计数
pm2 reset sentra-agent
```

## 性能优化

### 调整内存限制

编辑 `ecosystem.config.cjs`：

```javascript
max_memory_restart: '2G',  // 根据实际情况调整
```

### 启用集群模式（高级）

```javascript
instances: 'max',         // 使用所有 CPU 核心
exec_mode: 'cluster',     // 集群模式
```

⚠️ **注意**：启用集群模式需要确保代码支持多进程（无状态、使用 Redis 共享数据等）

## 对比：直接运行 vs PM2

| 特性 | `node Main.js` | PM2 |
|------|----------------|-----|
| 自动重启 | ❌ | ✅ |
| 日志管理 | ❌ | ✅ |
| 资源监控 | ❌ | ✅ |
| 零停机重载 | ❌ | ✅ |
| 开机自启 | ❌ | ✅ |
| 集群模式 | ❌ | ✅ |
| 适用场景 | 开发/测试 | 生产环境 |

## 常见问题

### Q: PM2 和直接 node 运行有什么区别？

A: PM2 提供进程守护、自动重启、日志管理、资源监控等生产级特性，而直接运行适合开发测试。

### Q: 如何查看历史日志？

A: 日志文件保存在 `logs/` 目录，可以直接查看文件或使用 `pm2 logs --lines 1000`。

### Q: 服务占用内存过高怎么办？

A: 调整 `max_memory_restart` 配置，或检查代码是否有内存泄漏。

### Q: 如何在多台服务器上部署？

A: 使用 [PM2 Ecosystem File](https://pm2.keymetrics.io/docs/usage/deployment/) 的 `deploy` 配置。

## 相关资源

- [PM2 官方文档](https://pm2.keymetrics.io/docs/usage/quick-start/)
- [PM2 Plus 监控平台](https://pm2.io/)
- [PM2 GitHub](https://github.com/Unitech/pm2)

---

**提示**：生产环境强烈建议使用 PM2 管理进程，确保服务稳定性和可维护性。
