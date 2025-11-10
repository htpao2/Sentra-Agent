# 情绪/情感/PAD(VAD)/压力分析服务（FastAPI）

本项目提供一个基于真实神经网络模型（Hugging Face Transformers）的文本分析服务：
- 情感极性（正/中/负）
- 多类别情绪分布（如 joy/anger/fear/sadness/...）
- VAD/PAD（Valence/Arousal/Dominance 与 Pleasure/Arousal/Dominance）
- 压力分值（依据 V 与 A 等派生的可解释公式，范围 0~1）

注意：VAD/PAD 当前通过“情绪分布 → 连续维度”的业界常用映射法估计；后续可无缝接入直接回归VAD的模型。

## 依赖安装

- Python 3.10+
- Windows 下建议使用 venv

```powershell
python -m venv .venv
. .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

本服务离线运行：仅从本项目的 `models/` 目录加载模型文件，无需联网；环境变量可选，用于调参与设备选择。

## 运行

有两种方式，推荐使用 run.py 以便自动读取 `.env`：

```powershell
python run.py  # 读取 APP_HOST/APP_PORT 等配置
```

或使用 Uvicorn 手动指定端口：

```powershell
uvicorn app.main:app --host 0.0.0.0 --port 7200 --reload
```

建议在 `.env` 中显式设置：

```
APP_HOST=127.0.0.1
APP_PORT=7200
```

浏览器打开 http://127.0.0.1:7200/docs（或 http://<APP_HOST>:<APP_PORT>/docs）查看交互式接口。

## 本地模型目录与选择规则（无需联网）

将 Hugging Face 模型文件（`config.json`、`tokenizer.*`、`pytorch_model.bin` 或 `model.safetensors` 等）放入如下目录：

```
models/
  sentiment/                 # 情感模型（正/负/中 等）
    # 方式A：直接放模型文件在此目录（包含 config.json 等）
    # 方式B：按子目录放置多个模型：
    erlangshen/              # 示例子目录1（含完整模型文件）
    jd_binary/               # 示例子目录2
    priority.txt             # 可选：首行写入首选子目录名（如：erlangshen）

  emotion/                   # 情绪模型（joy/anger/... 分布）
    xlm_emo/                 # 示例子目录1
    other_emotion_model/     # 示例子目录2
    priority.txt             # 可选：首行写入首选子目录名
```

选择规则：
- 优先使用环境变量选择器（绝对路径或子目录名）：
  - 情绪模型：`SENTRA_EMOTION_MODEL`
  - 情感模型：`SENTRA_SENTIMENT_MODEL`
  - 示例：`SENTRA_EMOTION_MODEL=xlm_emo` 或 `SENTRA_EMOTION_MODEL=e:/models/my_emo`
- 若未设置环境变量：
  - 如果 `models/<kind>/` 目录本身包含 `config.json`，直接加载该目录。
  - 否则扫描子目录：
    - 若存在 `priority.txt`，其首行对应的子目录优先；
    - 否则按子目录名的字母序选择第一个。

注意：服务端严格以本地文件加载（`local_files_only=True`），若目录不存在或不完整会直接报错，不会尝试网络下载。

## API

- GET `/health`：存活检查
- GET `/models`：返回已选择的本地模型与 VAD 配置状态
- GET `/metrics`：推理耗时与设备信息等指标
- POST `/analyze`：单条文本分析（可携带 `userid/username` 追踪）
- POST `/analyze/batch`：批量文本分析
- GET `/user/{userid}`：获取用户聚合状态（EMA 后的 VAD、stress、top emotions）
- GET `/user/{userid}/events?limit=200&start=&end=`：用户事件流水（按时间范围）
- GET `/user/{userid}/analytics?days=30&start=&end=`：近窗期统计（含 MBTI、阈值）
- POST `/user/{userid}/export`：导出用户事件为 Parquet

请求体：
```json
{
  "text": "这次发布延期太久了，我压力很大，还挺生气的。"
}
```

响应示例（字段可能因模型不同略有差异）：
```json
{
  "sentiment": {
    "label": "negative",
    "scores": {"negative": 0.82, "neutral": 0.10, "positive": 0.08},
    "raw_model": "IDEA-CCNL/Erlangshen-Roberta-110M-Sentiment"
  },
  "emotions": [
    {"label": "anger", "score": 0.55},
    {"label": "sadness", "score": 0.18},
    {"label": "fear", "score": 0.10},
    {"label": "joy", "score": 0.05},
    {"label": "neutral", "score": 0.12}
  ],
  "vad": {"valence": 0.27, "arousal": 0.76, "dominance": 0.49, "method": "emotion_mapping"},
  "pad": {"pleasure": 0.27, "arousal": 0.76, "dominance": 0.49},
  "stress": {"score": 0.73, "level": "high"},
  "models": {
    "sentiment": "IDEA-CCNL/Erlangshen-Roberta-110M-Sentiment",
    "emotion": "MilaNLProc/xlm-emo-t"
  }
}
```

## 模型与最佳实践

- **仅本地模型**：请将你需要的模型完整文件夹放入 `models/sentiment/` 与 `models/emotion/`。
- **多模型管理**：可放多个子目录，通过 `priority.txt` 控制优先级，或按字母序默认选择。
- **VAD/PAD**：
  - 默认采用“情绪分布 → VAD/PAD”的经验映射；
  - 如需更贴合业务，可在 `app/analysis.py` 中调整 `VAD_MAP` 或替换为你本地的 VAD 回归模型（可另建 `models/vad/` 并在代码中接入）。
- **压力分值**：
  - 目前以 `Stress = clip(0,1, 0.6*(1 - V) + 0.4*A + 0.15*NegEmotionSum)` 计算，可解释、可调参。

### VAD 映射与别名、负向标签

- `vad_map.json` 与 `label_alias.json` 的搜索顺序（就近原则）：
  - 模型目录下 → 模型目录的父目录 → `app/config/vad_map.json` → `app/vad_maps/default.json`
- 未知标签会写入 `unknown_labels.json`（位于模型目录的父目录），便于补齐映射。
- 负向标签识别：
  - 优先从 `negative_emotions.json` 加载；
  - 否则按阈值推导（`NEG_VALENCE_THRESHOLD`，默认 0.4，V 小于该值视为负向）。

### 设备与推理设置

- 设备选择：`SENTRA_DEVICE=auto|cpu|cuda`
- GPU 选择优先项：`SENTRA_CUDA_SELECTOR`（支持 `index=N`、`name=SUBSTR`、`first`、`last`、`max_mem`）
- 回退选项：`SENTRA_CUDA_INDEX`

### Node SDK 快速开始（可选）

```javascript
import SentraEmo from './sdk/index.js';

const sdk = new SentraEmo({ baseURL: 'http://127.0.0.1:7200', timeout: 60000 });
const userid = 'u_demo_001';

const r = await sdk.analyze('今天很开心', { userid, username: 'Alice' });
const analytics = await sdk.userAnalytics(userid, { days: 7 });
console.log(analytics.mbti?.type, analytics.thresholds);
```

SDK 的 TypeScript 类型已包含 MBTI 与阈值字段，便于前端对接。

### 配置总览（.env）

- 服务：`APP_HOST`，`APP_PORT`
- 设备：`SENTRA_DEVICE`，`SENTRA_CUDA_SELECTOR`，`SENTRA_CUDA_INDEX`
- 情绪多标签：`EMO_MULTI_LABEL`，`EMO_THRESHOLD`，`EMO_TOPK`
- 标签别名：`EMO_USE_ALIAS`，`EMOTION_LABELS_FILE`
- 负向阈值：`NEG_VALENCE_THRESHOLD`
- 用户追踪 EMA：`USER_STATE_FAST_HALFLIFE_SEC`，`USER_STATE_SLOW_HALFLIFE_SEC`，`USER_STATE_ADAPT_GAIN`，`USER_TOP_EMOTIONS`
- 可视化字体：`VISUAL_FONT_PATH`
- MBTI 调参：`MBTI_CLASSIFIER`，`MBTI_EXTERNAL_URL`，各维阈值 `MBTI_*`（详见下文“MBTI 推断与阈值调优”）

## 常见问题

- **启动报错：未发现本地模型**：请检查是否已按上面的目录结构放置模型文件；至少各放置一个情感模型与一个情绪模型。
- **输出解释**：响应中的 `models` 字段会返回实际使用的本地模型路径。不同模型标签集可能不同，情感部分会标准化为 `negative/neutral/positive` 三类，情绪部分为模型原始标签。
- **CPU/GPU**：默认 CPU 可运行，GPU 会更快。

## 用户情绪追踪与数据存储

### 数据架构

本服务使用 **DuckDB** + **Parquet** 的现代化数据架构：

- **DuckDB**：专为分析设计的嵌入式列存数据库，聚合查询比SQLite快10-100倍
- **Parquet**：高效的列式存储格式，支持直接可视化
- **每用户独立导出**：可按用户导出Parquet文件，用于Excel、Pandas、BI工具等

**文件结构：**
```
data/
├── sentra_emo.duckdb          # 主数据库（所有用户事件）
└── users/
    ├── {userid}.json          # 用户聚合状态（EMA更新）
    └── {userid}/
        └── events.parquet     # 用户导出数据（可视化格式）
```

### 追踪API

在分析请求中传入 `userid` 和 `username`（可选）即可自动追踪：

```python
POST /analyze
{
  "text": "今天心情不错",
  "userid": "u_001",
  "username": "张三"
}
```

**查询与分析：**
- `GET /user/{userid}` - 获取用户聚合状态（VAD、stress、top emotions）
- `GET /user/{userid}/events?limit=200` - 获取用户事件流水
- `GET /user/{userid}/analytics?days=30` - 获取统计分析（近N天）
- `POST /user/{userid}/export` - 导出为Parquet格式

### Python可视化模块（推荐）

项目提供了 **`visualizer.py`** 模块，可直接生成专业的情绪分析图表：

```python
from visualizer import generate_user_emotion_chart

# 生成用户情绪趋势图（返回图片绝对路径）
chart_path = generate_user_emotion_chart(
    userid='u_demo_001',
    days=7,
    output_dir='output'
)
print(f"图表已生成: {chart_path}")
```

**功能特性**：
- ✅ 自动生成专业图表（Valence/Arousal/Stress/Dominance趋势）
- ✅ 返回图片绝对路径，方便集成和分享
- ✅ 支持自定义时间范围、输出目录、图表尺寸
- ✅ **强制使用自定义字体**，确保中文显示一致性
- ✅ 时间轴使用本地时间（北京时间 UTC+8），直观清晰

### 字体配置（必需）

**下载推荐字体**（免费开源）：
- **思源黑体**：https://github.com/adobe-fonts/source-han-sans/releases
  - 下载文件：`SourceHanSansSC-Regular.otf`
- **霞鹜文楷**：https://github.com/lxgw/LxgwWenKai/releases
  - 下载文件：`LXGWWenKai-Regular.ttf`

**配置方式**：
```bash
# 方式1：放入 fonts 文件夹（推荐）
fonts/SourceHanSansSC-Regular.otf

# 方式2：设置环境变量
VISUAL_FONT_PATH=fonts/SourceHanSansSC-Regular.otf

# 验证字体
python check_fonts.py --custom
```

### 快速开始

```bash
# 1. 下载并配置字体（必需）
# 访问: https://github.com/adobe-fonts/source-han-sans/releases
# 下载 SourceHanSansSC-Regular.otf 到 fonts/

# 2. 验证字体
python check_fonts.py --custom

# 3. 运行可视化示例
python visualize_example.py

# 4. 或使用可视化模块
python -c "from visualizer import generate_user_emotion_chart; print(generate_user_emotion_chart('u_demo_001', 7))"
```

### 其他可视化工具

1. **DuckDB CLI**：`duckdb data/sentra_emo.duckdb`
2. **Streamlit仪表板**：交互式Web界面
3. **Evidence**：Markdown+SQL构建BI dashboard
4. **DuckDB-Wasm**：浏览器内直接查询

详见 [DATA_STORAGE.md](DATA_STORAGE.md) 完整指南。

## 目录结构

```
app/
  main.py          # FastAPI 入口
  models.py        # 模型加载与推理封装（Transformers）
  analysis.py      # 情绪→VAD/PAD映射，压力分值计算
  schemas.py       # Pydantic 请求/响应模型
  user_store.py    # 用户数据存储（DuckDB）
sdk/
  index.js         # Node.js SDK
  e2e.js           # E2E测试（包含userid/username）
  README.md        # SDK文档与使用示例
fonts/
  README.md        # 字体文件夹说明（必需配置）
requirements.txt
visualizer.py             # 可视化函数模块（返回图片绝对路径）
visualize_example.py      # 可视化示例脚本（强制自定义字体）
check_fonts.py            # 字体检查工具（--custom 检查自定义字体）
migrate_csv_to_duckdb.py  # CSV迁移工具
DATA_STORAGE.md           # 数据存储完整指南
UPGRADE_GUIDE.md          # 升级指南
FONT_TROUBLESHOOTING.md   # 字体问题排查指南
VISUALIZATION_OPTIMIZATION.md  # 可视化优化总结
README.md
```

## MBTI 推断与阈值调优

这一部分介绍我们如何基于真实的情绪/VAD统计来推断 MBTI，并且如何通过环境变量精细化调参。目标是既可解释，又能落地在你的业务里，便于反复校准。

### 推断思路（两种模式）

- 规则模式（默认）：基于近窗期的统计量和阈值，将四个维度分别判定后组合成类型。
  - I/E：使用 `avg_arousal`（活跃度均值）。低活跃更倾向 I，高活跃更倾向 E。
  - S/N：使用 `v_std`（愉悦度的标准差）。低波动更偏 S，高波动更偏 N。
  - T/F：使用 `pos_ratio`（正向样本占比，V≥POS_V_CUT 记为正向）。占比低偏 T，占比高偏 F。
  - J/P：使用 `a_std`（活跃度的标准差）。低波动更偏 J，高波动更偏 P。
- 外部模型模式：如果你已有更复杂的论文方法（聚类/监督模型），可以切换到 external 模式，服务会在统计阶段把特征汇总给你的模型，由你的模型给出最终 MBTI。

### 接口与返回字段

`GET /user/{userid}/analytics?days=7` 会在原有统计字段基础上，额外返回：

- 统计增强
  - `v_std, a_std, d_std`：V/A/D 的事件级标准差（越小越稳定）
  - `pos_ratio, neg_ratio`：V≥POS_V_CUT 的比例、V≤NEG_V_CUT 的比例
  - `top_emotions`：跨事件累计归一后的情绪分布（长期主导）
- MBTI 结果
  - `mbti.type`：如 `ISTJ`
  - `mbti.dimensions[]`：每一维的判定依据，例如：`{ axis: "IE", letter: "I", metric: "avg_arousal", value: 0.36, low: 0.48, high: 0.58, score: 0.92 }`
  - `mbti.confidence`：四维置信度的均值，范围 0~1
  - `mbti.dominant_emotion`：跨事件主导情绪（来自 `top_emotions`）
  - `mbti.traits_en`：该类型的英文特征关键词，快速理解画像
  - `mbti.explain_en`：逐维解释，包含数值和阈值区间，便于审计
- 阈值回传（便于前端直观对比）
  - `thresholds.IE_A|SN_VSTD|TF_POS|JP_ASTD = { low, high }`
  - `thresholds.POS_V_CUT / NEG_V_CUT`
  - `thresholds.VALENCE_BANDS = { negative_max, neutral_min/neutral_max, positive_min }`
  - `thresholds.STRESS_BANDS = { low_max: 0.33, medium_max: 0.66 }`

### 如何读懂这些数值

- `avg_valence` 与 `VALENCE_BANDS` 的关系决定了总体正负偏向；处在中性带时，`pos_ratio/neg_ratio` 才是更重要的分割指标。
- `avg_arousal` 决定 I/E。数值越低越偏 I，越高越偏 E。你可以通过 `MBTI_IE_A_LOW/HIGH` 微调对不同群体的敏感度。
- `v_std`（S/N）与 `a_std`（J/P）是“波动度”维度。低波动更偏稳定（S/J），高波动更偏开放/探索（N/P）。
- `mbti.explain_en` 会直接把每一维的“实际数值 vs 阈值区间”拼出来，便于审查与复盘。

### 环境变量（全部可调）

规则/模型切换：

- `MBTI_CLASSIFIER=heuristic | external`
- `MBTI_EXTERNAL_URL=` 外部模型的 HTTP POST 端点（external 模式时必需）

各维阈值：

- I/E：`MBTI_IE_A_LOW`，`MBTI_IE_A_HIGH`
- S/N：`MBTI_SN_VSTD_LOW`，`MBTI_SN_VSTD_HIGH`
- T/F：`MBTI_TF_POS_LOW`，`MBTI_TF_POS_HIGH`
- J/P：`MBTI_JP_ASTD_LOW`，`MBTI_JP_ASTD_HIGH`
- 正负划分：`MBTI_POS_V_CUT`，`MBTI_NEG_V_CUT`
- 计算上限：`MBTI_ANALYTICS_MAX_EVENTS`（聚合时最多扫描的事件数）

把这些键加入 `.env` 或使用默认值即可。完整示例见项目根目录的 `.env.example`。

### 外部分类器集成（可选）

当 `MBTI_CLASSIFIER=external` 时，服务会以 POST 请求发送一个聚合特征包给你的端点：

请求示例：

```json
{
  "userid": "u_demo_001",
  "avg_valence": 0.53,
  "avg_arousal": 0.36,
  "avg_dominance": 0.37,
  "v_std": 0.09,
  "a_std": 0.06,
  "d_std": 0.07,
  "pos_ratio": 0.52,
  "neg_ratio": 0.23,
  "top_emotions": [{"label": "neutral", "score": 0.34}, {"label": "joy", "score": 0.19}],
  "total_events": 80
}
```

期望返回：

```json
{
  "type": "ISFJ",
  "dimensions": [
    {"axis": "IE", "letter": "I"},
    {"axis": "SN", "letter": "S"},
    {"axis": "TF", "letter": "F"},
    {"axis": "JP", "letter": "J"}
  ],
  "method": "your_model_name",
  "confidence": 0.78
}
```

如果外部返回不完整或超时，系统会自动回退到规则模式，保证接口稳定可用。

### 现在支持的 16 种 MBTI 类型及英文特征关键词

- ISTJ: Practical, Fact-oriented, Dependable, Orderly
- ISFJ: Caring, Detail-oriented, Responsible, Supportive
- INFJ: Insightful, Ideal-driven, Empathetic, Purpose-focused
- INTJ: Strategic, Analytical, Efficient, Systems-oriented
- ISTP: Calm, Hands-on, Problem-solver, Pragmatic
- ISFP: Gentle, Aesthetic, Experience-focused, Adaptable
- INFP: Values-driven, Idealistic, Empathetic, Reflective
- INTP: Logical, Theoretical, Curious, Principle-seeking
- ESTP: Action-oriented, Spontaneous, Realistic, Decisive
- ESFP: Enthusiastic, Experiential, Sociable, Lively
- ENFP: Possibility-driven, Creative, Inspiring, Expressive
- ENTP: Dialectical, Innovative, Contrarian, Exploratory
- ESTJ: Organized, Managerial, Rule-focused, Results-oriented
- ESFJ: Caring, Cooperative, Harmony-building, Reliable
- ENFJ: Leadership, Empathetic, People-developing, Persuasive
- ENTJ: Goal-oriented, Decisive, Commanding, Organizer

### 快速测试与日志对照

1) 启动服务：

```powershell
python run.py
# 或等价：uvicorn app.main:app --host 0.0.0.0 --port 7200 --reload
```

2) 运行 SDK E2E：

```bash
node sdk/e2e.js
```

E2E 会打印 `userAnalytics` 的聚合统计、阈值 `thresholds`、以及 `mbti_detail`。你可以直接对照 `value` 与 `{low,high}`，快速评估是否需要调整阈值。

### 设计取舍与注意事项

- 所有阈值均参数化，便于 A/B 实验与业务自定义。
- 规则模式保持可解释性；当需要更复杂的判别力时，可随时切换到 external 模式。
- 情绪标签会受 `label_alias.json` 的别名表影响，VAD 映射则受 `vad_map.json` 影响；两者路径自动探测，未知标签会记录在 `unknown_labels.json`，便于补齐。
