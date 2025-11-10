# Mindmap Generator Plugin

生成思维导图的 Markdown 内容并渲染为图片。

## 功能特性

- ✅ 使用 LLM 自动生成 Markmap 格式的 Markdown
- ✅ 支持本地资源或 CDN 加载 d3/markmap 库
- ✅ 使用 Puppeteer 渲染为 PNG 图片
- ✅ **自动缩放优化**：检测思维导图尺寸，太小时自动放大并居中
- ✅ 多种预设样式：default、dark、minimal、colorful 等
- ✅ 可配置画布尺寸、等待时间、缩放参数

## 渲染优化（v1.2.0 最佳实践）

### 核心改进

使用 Markmap 内置配置系统，而不是手动调整 SVG transform：

1. **`fitRatio`** (0-1)：控制内容占视口的比例
   - 默认 0.9 = 内容占 90%，留 10% 边距
   - 避免内容紧贴边缘，视觉效果更好

2. **`maxInitialScale`**：限制最大初始缩放倍数
   - 默认 2.0 = 最多放大 2 倍
   - 防止过度放大导致只显示部分分支

3. **`autoFit: true`**：启用自动适配
   - 内容自动居中并填充视口
   - 不需要手动计算位置

### 配置参数

通过环境变量或 `pluginEnv` 配置：

```bash
# 适配比例（0-1），控制内容占视口的比例
MINDMAP_FIT_RATIO=0.9

# 最大缩放倍数，防止过度放大
MINDMAP_MAX_SCALE=2.0
```

### 配置建议

**场景 1：思维导图太小**
```bash
MINDMAP_FIT_RATIO=0.95   # 增加到 95%，减少边距
MINDMAP_MAX_SCALE=3.0    # 允许更大的缩放
```

**场景 2：思维导图过大（截图显示的问题）**
```bash
MINDMAP_FIT_RATIO=0.85   # 减少到 85%，增加边距
MINDMAP_MAX_SCALE=1.5    # 限制最大缩放为 1.5 倍
```

**场景 3：内容非常复杂**
```bash
MINDMAP_WIDTH=3200       # 增加画布宽度
MINDMAP_HEIGHT=2400      # 增加画布高度
MINDMAP_FIT_RATIO=0.9    # 保持标准比例
MINDMAP_MAX_SCALE=1.0    # 禁用放大，仅适配
```

### 调试信息

浏览器 console 输出：

```javascript
MARKMAP_FINAL: {
  bbox: { width: 1160, height: 406, x: -1, y: -158 },
  transform: "translate(1200,800) scale(1.85)"
}
MARKMAP_READY: true
```

服务端日志：

```
mindmap_gen: content bbox { bbox: { ... } }
```

## 参数说明

### 必需参数

- `prompt` (string): 思维导图描述，如"Vue3 生命周期"
- `filename` (string): 输出文件名（仅文件名，不含路径），如 `vue-lifecycle.png`

### 可选参数

- `width` (number): 画布宽度，默认 2400
- `height` (number): 画布高度，默认 1600
- `style` (string): 样式主题，可选：
  - `default`: 默认白色背景
  - `dark`: 暗色主题
  - `minimal`: 极简风格
  - `colorful`: 彩色渐变背景
  - `anime`、`cyberpunk`、`nature`、`business`、`code`、`academic`、`creative`、`retro`
- `waitTime` (number): 渲染等待时间（毫秒），默认 8000
- `render` (boolean): 是否渲染图片，默认 true

## 环境变量

### 资源加载

```bash
# 资源模式：local（本地）或 cdn（默认）
MINDMAP_ASSET_MODE=local

# 本地资源路径（assetMode=local 时使用）
MINDMAP_ASSET_D3_PATH=/path/to/d3.min.js
MINDMAP_ASSET_LIB_PATH=/path/to/markmap-lib.min.js
MINDMAP_ASSET_VIEW_PATH=/path/to/markmap-view.min.js
```

### LLM 配置

```bash
# 生成 Markdown 使用的模型
MINDMAP_MODEL=gpt-4o-mini
MINDMAP_API_KEY=your-api-key
MINDMAP_BASE_URL=https://api.openai.com/v1
```

### 渲染配置

```bash
# 画布尺寸
MINDMAP_WIDTH=2400
MINDMAP_HEIGHT=1600

# 默认样式
MINDMAP_DEFAULT_STYLE=default

# 等待时间
MINDMAP_WAIT_TIME=8000

# Markmap 渲染配置（v1.2.0 最佳实践）
MINDMAP_FIT_RATIO=0.9           # 适配比例（0-1）
MINDMAP_MAX_SCALE=2.0           # 最大缩放倍数
```

## 使用示例

### 基础用法

```javascript
const result = await mindmap_gen({
  prompt: "Python 数据分析工具链",
  filename: "python-data-analysis.png"
});

console.log(result.data.path);  // artifacts/python-data-analysis.png
console.log(result.data.markdown_content);  // 生成的 Markdown
```

### 自定义样式和尺寸

```javascript
const result = await mindmap_gen({
  prompt: "微服务架构演进",
  filename: "microservices.png",
  width: 3000,
  height: 2000,
  style: "dark"
});
```

### 仅生成 Markdown（不渲染）

```javascript
const result = await mindmap_gen({
  prompt: "机器学习算法分类",
  filename: "ml-algorithms.png",
  render: false
});

console.log(result.data.markdown_content);
// 输出：
// # 机器学习
// ## 监督学习
// ### 分类
// ### 回归
// ## 无监督学习
// ...
```

### 使用 pluginEnv 配置

```javascript
const result = await mindmap_gen(
  {
    prompt: "前端框架对比",
    filename: "frontend-frameworks.png"
  },
  {
    pluginEnv: {
      MINDMAP_MODEL: "claude-3-5-sonnet-20241022",
      MINDMAP_WIDTH: 3200,
      MINDMAP_FIT_RATIO: 0.85,  // 减少适配比例，留更多边距
      MINDMAP_MAX_SCALE: 1.5     // 限制最大缩放
    }
  }
);
```

## 返回值

```javascript
{
  success: true,
  data: {
    prompt: "用户输入的描述",
    markdown_content: "# 主题\n## 子节点\n...",
    path: "E:/sentra-agent/sentra-mcp/artifacts/xxx.png",  // 绝对路径
    path_markdown: "![xxx.png](E:/sentra-agent/sentra-mcp/artifacts/xxx.png)",
    width: 2400,
    height: 1600,
    style: "default",
    generation_info: {
      model: "gpt-4o-mini",
      created: 1699123456,
      baseURL: "https://..."
    }
  }
}
```

## 故障排查

### 1. 思维导图太小或太大

**症状 A：太小**
- 思维导图挤在左上角
- 大部分画布空白
- 内容难以查看

**症状 B：太大（如截图所示）**
- 只显示部分分支
- 根节点或某些分支被裁掉
- 内容过度放大

**解决方案**：

```bash
# 太小的情况
MINDMAP_FIT_RATIO=0.95   # 增加适配比例
MINDMAP_MAX_SCALE=3.0    # 允许更大缩放

# 太大的情况
MINDMAP_FIT_RATIO=0.85   # 减少适配比例，增加边距
MINDMAP_MAX_SCALE=1.5    # 限制最大缩放（关键！）

# 极端情况：禁用放大
MINDMAP_MAX_SCALE=1.0    # 仅适配，不放大
```

**调试**：查看浏览器日志中的 `MARKMAP_FINAL` 信息

### 2. 渲染超时

**症状**：`Markmap initialization timeout after Xms`

**解决**：
- 增加 `waitTime` 参数
- 检查网络（如使用 CDN 资源）
- 改用本地资源：`MINDMAP_ASSET_MODE=local`
- 查看保留的临时 HTML 文件进行调试

### 3. 本地资源加载失败

**症状**：日志显示 `local assets missing, falling back to CDN`

**解决**：
- 确保 `assets/` 目录下有 `d3.min.js`、`markmap-lib.min.js`、`markmap-view.min.js`
- 或明确指定路径：`MINDMAP_ASSET_D3_PATH=...`

### 4. Markdown 生成质量差

**症状**：生成的思维导图结构混乱、层级不清

**解决**：
- 更换更强的模型：`MINDMAP_MODEL=gpt-4o` 或 `claude-3-5-sonnet-20241022`
- 优化 `prompt`，提供更具体的要求
- 检查 `markdown_content` 是否符合 Markmap 格式

## 技术细节

### 渲染流程

1. **生成 Markdown**：调用 LLM 生成符合 Markmap 格式的 Markdown
2. **验证格式**：检查 Markdown 是否包含 `#` 标题、无代码块标记
3. **构建 HTML**：嵌入 d3/markmap 库和样式
4. **Puppeteer 渲染**：
   - 启动无头浏览器
   - 加载 HTML（使用 `file://` 协议）
   - 等待 `window.__MARKMAP_READY__` 标志
   - 调用 `mm.fit()` 适配视口
   - **检测尺寸并自动缩放**（新增）
   - 截图保存

### Markmap 配置（最佳实践）

使用内置配置选项，而不是手动调整 SVG transform：

```javascript
const mm = Markmap.create(svg, {
  autoFit: true,              // 自动适配视口
  zoom: true,                 // 启用缩放
  pan: true,                  // 启用平移
  duration: 0,                // 禁用动画（截图时不需要）
  maxWidth: 0,                // 不限制节点宽度
  initialExpandLevel: -1,     // 展开所有层级
  fitRatio: 0.9,              // 适配比例（0.9 = 留 10% 边距）
  maxInitialScale: 2.0,       // 最大初始缩放（防止过度放大）
  paddingX: 8                 // 水平内边距
}, root);

// 使用内置 fit 方法，传入 maxScale 限制
mm.fit(2.0);  // 最大缩放 2 倍
```

### 为什么不手动调整？

**手动调整的问题**：
- 计算复杂，容易出错
- 可能导致内容偏移或过度缩放
- 不同内容需要不同的计算逻辑

**使用内置配置的优势**：
- Markmap 内部算法经过优化
- `fitRatio` 控制边距，`maxInitialScale` 控制缩放
- 自动居中，无需手动计算位置
- 适用于各种内容结构

## 更新日志

### v1.2.0 (2024-11-05) - 最佳实践优化

- 🎯 **重构**：使用 Markmap 内置配置系统，移除手动 transform 调整
- ✨ **新增**：`fitRatio` 配置（0-1），控制内容占视口比例
- ✨ **新增**：`maxInitialScale` / `maxScale` 配置，防止过度放大
- 🐛 **修复**：解决思维导图过大只显示部分分支的问题
- 🐛 **修复**：解决 `browser.close()` 卡住导致函数不返回的问题
- 📝 **文档**：新增配置建议和多场景解决方案
- 🗑️ **移除**：废弃 `MINDMAP_MIN_CONTENT_RATIO` 和 `MINDMAP_TARGET_RATIO`

**迁移指南**：
```bash
# 旧配置（已废弃）
MINDMAP_MIN_CONTENT_RATIO=0.4
MINDMAP_TARGET_RATIO=0.75

# 新配置（推荐）
MINDMAP_FIT_RATIO=0.9       # 适配比例
MINDMAP_MAX_SCALE=2.0       # 最大缩放
```

### v1.1.0 (2024-11-05)

- ✨ **新增**：自动缩放优化，解决思维导图渲染太小的问题
- ✨ **新增**：`MINDMAP_MIN_CONTENT_RATIO` 和 `MINDMAP_TARGET_RATIO` 配置
- ✨ **新增**：详细的调试日志（bbox、缩放信息）
- 🐛 **修复**：`mm.fit()` 延迟时间从 300ms 增加到 500ms，确保布局稳定
- 🐛 **修复**：截图前增加 500ms 延迟，确保缩放完全生效
- 📝 **文档**：新增完整的 README 和故障排查指南

### v1.0.0 (2024-10-01)

- 🎉 初始版本
- ✅ 支持 LLM 生成 Markdown
- ✅ 支持 Puppeteer 渲染图片
- ✅ 支持本地/CDN 资源加载
- ✅ 支持多种样式主题

## 相关文件

- `index.js`: 主插件逻辑
- `assets/`: 本地 JS 资源（可选）
- `README.md`: 本文档
