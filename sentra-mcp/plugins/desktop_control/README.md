# Desktop Control Plugin（专注版）

基于 nircmd.exe 的桌面应用控制插件，专注于：应用 / 窗口 / 键盘 / 鼠标。

- ✅ 单一输入：`instruction`（自然语言指令）
- ✅ 能力范围：打开应用、聚焦/最大化/最小化/关闭窗口，鼠标移动/点击，键盘按键/输入
- ✅ 轻量无依赖：仅需 nircmd.exe

---

## 🎯 使用方式

插件只接受一个参数：`instruction`（string）。示例：

- 打开并最大化 Steam：`open steam and maximize`
- 激活 Chrome：`focus chrome`
- 关闭记事本：`close notepad`
- 显示桌面：`minimize all`
- 移动鼠标到 960,540：`move mouse to 960,540`
- 右键点击：`right click`
- 按 Win+D：`press win+d`
- 输入文本：`type hello world`

---

## 📥 安装 nircmd.exe

### 方法 1：下载到插件目录（推荐）

```bash
# 1. 下载
curl -L -o nircmd.zip https://www.nirsoft.net/utils/nircmd-x64.zip

# 2. 解压到插件 bin 目录
# 手动解压或使用：
# Windows PowerShell: Expand-Archive nircmd.zip -DestinationPath plugins/desktop_control/bin/
# 确保文件路径为：plugins/desktop_control/bin/nircmd.exe
```

### 方法 2：安装到系统 PATH

```bash
# 将 nircmd.exe 复制到系统目录
copy nircmd.exe C:\Windows\System32\
```

### 验证安装

确保 `nircmd.exe` 位于：`plugins/desktop_control/bin/nircmd.exe` 或系统 PATH 中即可。

---

## 🚀 工具调用（与 OpenAI tools + tool_choice 配合）

以 `instruction` 作为唯一入参，配合规划器逐步调用：

```json
{
  "name": "desktop_control",
  "arguments": { "instruction": "open steam and maximize" }
}
```

---
## 🔍 故障排查

- 无法控制某个应用：确认进程名（不区分大小写，可不含 .exe），或改用窗口标题（在 `instruction` 中用引号包裹标题：`close "无标题 - 记事本"`）。
- 权限问题：无法控制以管理员权限运行的进程，除非脚本也以管理员运行。
- nircmd 未找到：将 `nircmd.exe` 放到 `plugins/desktop_control/bin/` 或加入系统 PATH。

---

## 📚 参考

- nircmd 官网：https://www.nirsoft.net/utils/nircmd.html
- 命令列表：https://nircmd.nirsoft.net/commands.html

