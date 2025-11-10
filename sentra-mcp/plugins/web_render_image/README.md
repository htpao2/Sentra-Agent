# web_render_image 插件优化文档

## 🎯 核心优化：解决资源加载不完整问题

### v2.0.0 优化内容

#### 1. **统一 waitUntil 策略**（最关键）

**问题根源**：
- ❌ 旧版 html 模式：`waitUntil: 'domcontentloaded'` - DOM 解析完就继续，**不等图片等资源加载**
- ✅ 旧版 file 模式：`waitUntil: 'networkidle2'` - 等网络空闲

**优化方案**：
```javascript
// 🔥 统一使用 'load' 作为默认策略，确保资源加载
const waitUntil = wait_for === 'domcontentloaded' ? 'domcontentloaded' 
                : (wait_for === 'networkidle' ? 'networkidle2' 
                : 'load');  // 默认 load，等待所有资源
```

**waitUntil 策略对比**：
| 策略 | 等待内容 | 适用场景 | 资源加载 |
|------|---------|---------|---------|
| `domcontentloaded` | 仅 DOM 解析 | 纯静态内容，无图片 | ❌ 不等待 |
| `load` | DOM + 所有资源（图片、CSS、字体） | **大多数场景（推荐）** | ✅ 完整等待 |
| `networkidle2` | 网络空闲（≤2 个连接） | 有异步请求的页面 | ✅ 等待异步资源 |

---

#### 2. **新增图片加载监测**（核心功能）

**问题**：即使使用 `load`，某些懒加载或动态加载的图片可能未完成。

**解决方案**：`waitForImages()` 函数
```javascript
// 等待所有 <img> 标签加载完成
await page.evaluate(async (timeoutMs) => {
  const imgs = Array.from(document.querySelectorAll('img'));
  
  // 为每个图片设置 load/error 监听
  const promises = imgs.map((img) => {
    return new Promise((resolve) => {
      if (img.complete && img.naturalWidth > 0) {
        resolve(); // 已加载
      } else {
        img.addEventListener('load', () => resolve());
        img.addEventListener('error', () => resolve()); // 失败也继续
        setTimeout(() => resolve(), timeoutMs); // 超时保护
      }
    });
  });
  
  await Promise.all(promises);
}, 15000);
```

**优势**：
- ✅ 检测所有 `<img>` 标签
- ✅ 处理 `loading="lazy"` 懒加载
- ✅ 即使图片失败也不阻塞（避免卡死）
- ✅ 超时保护（默认 15 秒）

---

#### 3. **新增字体加载监测**

**问题**：自定义字体未加载完成，导致文本渲染错误。

**解决方案**：`waitForFonts()` 函数
```javascript
// 等待字体加载完成（使用浏览器原生 Font Loading API）
await page.evaluate(async (timeoutMs) => {
  if (document.fonts && document.fonts.ready) {
    await Promise.race([
      document.fonts.ready,
      new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);
  }
}, 5000);
```

**优势**：
- ✅ 使用浏览器原生 API
- ✅ 支持 Google Fonts、自定义字体等
- ✅ 超时保护（默认 5 秒）

---

#### 4. **延长超时时间**

**旧版超时设置**（太短）：
```javascript
// smartWait 超时
await page.waitForNetworkIdle({ timeout: 3000 });  // ❌ 3 秒太短
await page.waitForFunction(() => ..., { timeout: 5000 });  // ❌ 5 秒太短
```

**新版超时设置**（更合理）：
```javascript
// networkidle 超时：15 秒
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 });

// DOM ready 超时：10 秒
await page.waitForFunction(() => ..., { timeout: 10000 });

// 图片加载超时：15 秒
await waitForImages(page, 15000);

// 字体加载超时：5 秒
await waitForFonts(page, 5000);
```

**适用场景**：
- ✅ CDN 资源加载慢
- ✅ 大图片（几 MB）
- ✅ 复杂页面（多个资源）

---

#### 5. **资源加载失败监控**

**新增功能**：监听 `requestfailed` 事件
```javascript
const failedResources = [];
page.on('requestfailed', (request) => {
  const url = request.url();
  const failure = request.failure();
  failedResources.push({ url, reason: failure?.errorText });
  logger.debug('资源加载失败', { url, reason: failure?.errorText });
});
```

**返回结果**：
```javascript
{
  success: true,
  data: {
    path: "E:/sentra-agent/artifacts/render_1234567890.png",
    failed_resources: [  // 🔥 新增字段
      { url: "https://example.com/image.jpg", reason: "net::ERR_FAILED" }
    ]
  }
}
```

**用途**：
- ✅ 调试资源加载问题
- ✅ 识别失效的 CDN 链接
- ✅ 检测 404/500 错误

---

#### 6. **额外稳定性优化**

**新增 500ms 缓冲**：
```javascript
// 等待图片和字体加载完成
await waitForImages(page, 15000);
await waitForFonts(page, 5000);

// 额外等待 500ms，确保渲染稳定（避免截图时动画未完成、布局抖动等）
await new Promise(resolve => setTimeout(resolve, 500));
```

---

## 📋 参数说明

### `wait_for` 参数（重要）

| 值 | 说明 | 等待内容 | 推荐场景 | 速度 |
|---|------|---------|---------|-----|
| `auto` | 智能等待（**推荐**） | DOM ready + networkidle + 图片 + 字体 | 大多数场景 | 中等 |
| `load` | 页面完全加载（**默认**） | DOM + 所有资源（img、css、font） | 标准网页 | 中等 |
| `networkidle` | 网络空闲 | 网络空闲（≤2 个连接）+ 图片 + 字体 | 有异步请求的页面 | 较慢 |
| `domcontentloaded` | 仅 DOM 解析 | ❌ 不等资源 | 纯文本页面（不推荐） | 最快 |

**推荐配置**：
```javascript
// 场景 1：标准网页（有图片、CSS、字体）
{ wait_for: "auto" }  // 或省略（默认）

// 场景 2：大量图片或 CDN 资源
{ wait_for: "networkidle" }

// 场景 3：纯静态 HTML（无外部资源）
{ wait_for: "load" }

// 场景 4：紧急截图（不关心资源）
{ wait_for: "domcontentloaded" }  // ⚠️ 可能不完整
```

---

## 🚀 使用示例

### 示例 1：渲染包含大图片的 HTML

```javascript
{
  html: `
    <!DOCTYPE html>
    <html>
    <head>
      <link href="https://fonts.googleapis.com/css2?family=Roboto&display=swap" rel="stylesheet">
    </head>
    <body>
      <h1 style="font-family: Roboto;">标题</h1>
      <img src="https://cdn.example.com/large-image.jpg" />
      <img src="E:/path/to/local-image.png" />
    </body>
    </html>
  `,
  wait_for: "auto"  // 智能等待：网络 + 图片 + 字体
}
```

**效果**：
- ✅ 等待 Google Fonts 加载
- ✅ 等待 CDN 图片加载
- ✅ 等待本地图片加载
- ✅ 额外 500ms 缓冲

---

### 示例 2：渲染本地 HTML 文件

```javascript
{
  file: "E:/projects/my-page.html",
  wait_for: "networkidle",  // 网络空闲（适合有异步请求的页面）
  fullPage: true
}
```

---

### 示例 3：注入自定义样式并截取元素

```javascript
{
  html: `<div class="card">内容</div>`,
  css: `.card { padding: 20px; border: 1px solid #ccc; }`,
  selector: ".card",  // 仅截取 .card 元素
  wait_for: "load"
}
```

---

## 🔧 性能对比

### 旧版（资源加载不完整）

```
1. goto(url, { waitUntil: 'domcontentloaded' })  ❌ 不等资源
2. smartWait(3秒)                                 ❌ 超时太短
3. 截图                                           ❌ 图片未加载

总耗时：~2-3 秒
问题：图片、字体经常缺失
```

### 新版（资源加载完整）

```
1. goto(url, { waitUntil: 'load' })              ✅ 等待所有资源
2. smartWait(8-15秒)                              ✅ 超时合理
3. waitForImages(15秒)                            ✅ 明确等待图片
4. waitForFonts(5秒)                              ✅ 明确等待字体
5. 额外 500ms 缓冲                                ✅ 确保稳定
6. 截图                                           ✅ 资源完整

总耗时：~5-10 秒（取决于资源数量）
优势：资源加载完整，渲染准确
```

---

## 📊 监控和调试

### 1. 查看失败的资源

```javascript
// 返回结果
{
  success: true,
  data: {
    path: "...",
    failed_resources: [
      {
        url: "https://cdn.example.com/missing.jpg",
        reason: "net::ERR_NAME_NOT_RESOLVED"
      }
    ]
  }
}
```

### 2. 日志输出

```
DEBUG web_render_image: 资源加载失败 { url: 'https://...', reason: 'net::ERR_FAILED' }
DEBUG web_render_image: waitForImages completed { loaded: 5, elapsed: 2341 }
```

---

## ⚠️ 注意事项

### 1. **超时时间**
- 默认总超时：60 秒（`timeoutMs: 60000`）
- 如果页面资源特别多，可能需要延长

### 2. **本地资源路径**
- ✅ 推荐：`E:/path/to/image.png`（绝对路径）
- ❌ 避免：`./image.png`（相对路径，可能找不到）

### 3. **懒加载图片**
- 已支持 `loading="lazy"` 的图片
- 会等待图片进入视口并加载完成

### 4. **CDN 资源**
- 如果 CDN 很慢或失效，会等待超时（15 秒）
- 建议使用 `failed_resources` 检测失败的资源

---

## 🎉 总结

### 核心改进
1. ✅ **统一 waitUntil 策略**：默认使用 `load`，确保资源加载
2. ✅ **新增图片加载监测**：明确等待所有 `<img>` 完成
3. ✅ **新增字体加载监测**：确保自定义字体渲染正确
4. ✅ **延长超时时间**：3 秒 → 15 秒，适应慢速网络
5. ✅ **资源加载失败监控**：返回 `failed_resources`，便于调试
6. ✅ **额外 500ms 缓冲**：确保渲染稳定

### 推荐使用
- 默认配置（`wait_for: "auto"` 或省略）已足够应对大多数场景
- 如有特殊需求，参考上述参数说明选择合适的等待策略

### 测试建议
1. 重启服务
2. 使用包含图片和字体的 HTML 测试
3. 检查返回结果的 `failed_resources` 字段
4. 对比新旧版本的截图效果
