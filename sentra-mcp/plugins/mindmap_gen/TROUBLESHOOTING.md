# Mindmap 插件超时问题排查指南

## ✅ 已完成的优化

1. **本地资源加载**：避免 CDN 网络延迟
2. **增强调试日志**：监听页面控制台和错误
3. **改进初始化逻辑**：确保脚本加载完成后再初始化
4. **保留失败的 HTML 文件**：便于手动调试

---

## 🔍 排查步骤

### 步骤 1：查看详细日志

运行插件后，检查日志中的关键信息：

```
✅ 成功标志：
INFO  PLUGIN  mindmap_gen: using local assets
INFO  PLUGIN  mindmap_gen: markmap ready

❌ 失败标志：
ERROR PLUGIN  mindmap_gen: page error
ERROR PLUGIN  mindmap_gen: timeout waiting for ready flag
WARN  PLUGIN  mindmap_gen: temp HTML kept for debugging
```

### 步骤 2：手动测试 HTML

如果出现超时，插件会保留临时 HTML 文件，日志会显示路径：

```
WARN  PLUGIN  mindmap_gen: temp HTML kept for debugging
┃ path: E:\sentra-agent\sentra-mcp\artifacts\mindmap-1730XXXXX.html
```

**手动测试步骤**：

1. 找到上述 HTML 文件路径
2. 用浏览器打开该文件（Chrome/Edge）
3. 按 F12 打开开发者工具
4. 查看 Console 标签页的错误信息

**期望看到**：
```
MARKMAP_READY: true
```

**如果看到错误**：
```
MARKMAP_INIT_ERROR: markmap global is undefined
```
说明本地 JS 文件没有正确加载或暴露全局变量。

---

## 🛠️ 常见问题与解决方案

### 问题 1：`window.markmap is undefined`

**原因**：本地 JS 文件没有正确暴露全局变量

**解决方案**：

检查下载的文件是否正确：

```powershell
# 检查文件大小
Get-Item plugins\mindmap_gen\assets\*.js | Select-Object Name, Length
```

**期望输出**：
```
Name                    Length
----                    ------
d3.min.js              270687
markmap-lib.min.js     896354
markmap-view.min.js     51958
```

如果文件大小不对或为 0，重新下载：

```powershell
cd plugins\mindmap_gen
Remove-Item assets\*.js
# 然后执行下载命令
```

### 问题 2：脚本加载超时

**原因**：Puppeteer 等待脚本加载超时

**解决方案**：

1. 增加等待时间（`.env` 文件）：
```
MINDMAP_WAIT_TIME=15000
```

2. 检查系统资源：
   - CPU 占用是否过高
   - 磁盘 I/O 是否缓慢
   - 杀毒软件是否拦截 Puppeteer

### 问题 3：Puppeteer 无法启动

**错误信息**：
```
Error: Failed to launch the browser process
```

**解决方案**：

1. 确认 Puppeteer 已安装：
```powershell
npm list puppeteer
```

2. 如未安装或版本过旧，重新安装：
```powershell
npm install puppeteer@latest
```

3. Windows 可能需要额外权限，以管理员运行 PowerShell。

---

## 🧪 测试本地资源是否有效

创建一个最小化测试 HTML：

```powershell
cd plugins\mindmap_gen
```

创建 `test.html`（手动或用编辑器）：

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <script src="file:///E:/sentra-agent/sentra-mcp/plugins/mindmap_gen/assets/d3.min.js"></script>
  <script src="file:///E:/sentra-agent/sentra-mcp/plugins/mindmap_gen/assets/markmap-lib.min.js"></script>
  <script src="file:///E:/sentra-agent/sentra-mcp/plugins/mindmap_gen/assets/markmap-view.min.js"></script>
</head>
<body>
  <svg id="markmap" width="800" height="600"></svg>
  <script>
    setTimeout(() => {
      console.log('d3:', typeof d3);
      console.log('markmap:', typeof markmap);
      if (typeof markmap !== 'undefined') {
        console.log('markmap.Transformer:', typeof markmap.Transformer);
        console.log('markmap.Markmap:', typeof markmap.Markmap);
        document.body.innerHTML += '<h1 style="color:green">✅ Scripts loaded!</h1>';
      } else {
        document.body.innerHTML += '<h1 style="color:red">❌ markmap undefined</h1>';
      }
    }, 500);
  </script>
</body>
</html>
```

用 Chrome 打开，F12 查看 Console，应该看到：
```
d3: object
markmap: object
markmap.Transformer: function
markmap.Markmap: function
✅ Scripts loaded!
```

---

## 📊 性能优化建议

如果 markmap 初始化慢：

1. **减少图片尺寸**：
```
MINDMAP_WIDTH=1920
MINDMAP_HEIGHT=1200
```

2. **使用更快的模型生成 Markdown**：
```
MINDMAP_MODEL=gpt-4o-mini
# 或
MINDMAP_MODEL=gemini-2.0-flash-exp
```

3. **减少 Markdown 节点数量**：
   - 限制层级深度（建议 ≤ 4 级）
   - 减少子节点数量
   - 简化文本内容

---

## 🆘 仍然无法解决？

提供以下信息以便诊断：

1. **完整的错误日志**（从插件调用开始到失败）
2. **临时 HTML 文件内容**（如果保留了）
3. **浏览器控制台截图**（手动打开 HTML 文件后）
4. **系统信息**：
   - Windows 版本
   - Node.js 版本：`node -v`
   - Puppeteer 版本：`npm list puppeteer`
5. **文件验证**：
```powershell
Get-FileHash plugins\mindmap_gen\assets\d3.min.js
Get-FileHash plugins\mindmap_gen\assets\markmap-lib.min.js
Get-FileHash plugins\mindmap_gen\assets\markmap-view.min.js
```

---

## 💡 临时回退方案

如果本地资源仍有问题，可临时回退 CDN：

`.env` 文件改为：
```
MINDMAP_ASSET_MODE=cdn
MINDMAP_WAIT_TIME=20000
```

CDN 虽然可能慢，但至少能确认是本地文件问题还是 markmap 本身的问题。
