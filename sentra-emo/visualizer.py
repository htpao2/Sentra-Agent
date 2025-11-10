"""
Sentra Emo 数据可视化模块

提供函数接口生成情绪数据可视化图表，返回图片绝对路径。

功能：
- 用户情绪趋势图（Valence, Arousal, Stress）
- 情感分布统计
- 支持自定义字体（必须配置，不回退到系统字体）
- 返回本地图片绝对路径

使用示例：
    from visualizer import generate_user_emotion_chart
    
    chart_path = generate_user_emotion_chart(
        userid='u_demo_001',
        days=7,
        output_dir='output',
        font_path='fonts/SourceHanSansSC-Regular.otf'
    )
    print(f"图表已生成: {chart_path}")
"""

import os
from pathlib import Path
from datetime import datetime, timedelta
import duckdb
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties
from matplotlib import font_manager as fm
from dotenv import load_dotenv

# 加载环境变量
load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env", override=True)


def load_custom_font(font_path: str = None) -> FontProperties:
    """
    加载自定义字体（必须指定，不回退到系统字体）
    
    Args:
        font_path: 字体文件路径（相对或绝对路径）
                  如果为None，从环境变量 VISUAL_FONT_PATH 读取
    
    Returns:
        FontProperties: 字体属性对象
    
    Raises:
        FileNotFoundError: 字体文件不存在
        ValueError: 字体文件无效或损坏
    """
    # 1. 从参数或环境变量获取字体路径
    if font_path is None:
        font_path = os.getenv('VISUAL_FONT_PATH', '').strip()
    
    if not font_path:
        raise ValueError(
            "必须指定字体文件路径！\n"
            "方式1: 设置环境变量 VISUAL_FONT_PATH=fonts/SourceHanSansSC-Regular.otf\n"
            "方式2: 调用时传入 font_path 参数\n"
            "推荐下载思源黑体: https://github.com/adobe-fonts/source-han-sans/releases"
        )
    
    # 2. 检查文件是否存在
    font_file = Path(font_path)
    if not font_file.exists():
        raise FileNotFoundError(
            f"字体文件不存在: {font_path}\n"
            f"当前工作目录: {Path.cwd()}\n"
            f"请确保字体文件已放置在正确位置"
        )
    
    # 3. 加载字体
    try:
        # 注册到 Matplotlib 字体管理器，确保可被 family 名称识别
        try:
            fm.fontManager.addfont(str(font_file))
        except Exception:
            pass
        try:
            fm._rebuild()
        except Exception:
            pass
        font_prop = FontProperties(fname=str(font_file))
        font_name = font_prop.get_name()
        
        # 验证字体名称是否有效
        if not font_name or '?' in font_name or len(font_name) < 3:
            raise ValueError(
                f"字体文件损坏或不兼容: {font_file.name}\n"
                f"字体名称: {font_name}\n"
                f"请使用标准的 .ttf/.otf 字体文件"
            )
        
        print(f"✓ 加载字体: {font_name} ({font_file.name})")
        return font_prop
        
    except Exception as e:
        raise ValueError(f"字体加载失败: {e}")


def configure_matplotlib_font(font_prop: FontProperties):
    """
    配置matplotlib全局字体设置
    
    Args:
        font_prop: 字体属性对象
    """
    font_name = font_prop.get_name()
    # 统一为 sans-serif，并将自定义字体置于首位，避免回退到 DejaVu Sans
    plt.rcParams['font.family'] = 'sans-serif'
    plt.rcParams['font.sans-serif'] = [font_name]
    plt.rcParams['font.serif'] = [font_name]
    plt.rcParams['font.cursive'] = [font_name]
    plt.rcParams['font.fantasy'] = [font_name]
    plt.rcParams['font.monospace'] = [font_name]
    plt.rcParams['axes.unicode_minus'] = False  # 解决负号显示问题
    plt.rcParams['figure.autolayout'] = True    # 自动调整布局


def generate_user_emotion_chart(
    userid: str,
    days: int = 7,
    output_dir: str = 'output',
    font_path: str = None,
    db_path: str = 'data/sentra_emo.duckdb',
    figsize: tuple = (14, 10),
    dpi: int = 100
) -> str:
    """
    生成用户情绪趋势图表
    
    Args:
        userid: 用户ID
        days: 查询最近N天的数据（默认7天）
        output_dir: 输出目录（默认output）
        font_path: 字体文件路径（可选，优先从环境变量读取）
        db_path: DuckDB数据库路径
        figsize: 图表尺寸（宽, 高），单位英寸
        dpi: 图片分辨率
    
    Returns:
        str: 生成的图片绝对路径
    
    Raises:
        FileNotFoundError: 数据库或字体文件不存在
        ValueError: 数据为空或字体无效
    """
    # 1. 加载字体并配置matplotlib
    font_prop = load_custom_font(font_path)
    configure_matplotlib_font(font_prop)
    
    # 2. 连接数据库
    db_file = Path(db_path)
    if not db_file.exists():
        raise FileNotFoundError(f"数据库文件不存在: {db_path}")
    
    conn = duckdb.connect(str(db_file))
    
    # 3. 查询数据（最近N天，本地时间）
    cutoff_time = datetime.now() - timedelta(days=days)
    query = """
        SELECT 
            ts,
            userid,
            sentiment,
            valence,
            arousal,
            dominance,
            stress
        FROM events
        WHERE userid = ? AND ts >= ?
        ORDER BY ts ASC
    """
    
    df = conn.execute(query, [userid, cutoff_time.isoformat()]).fetchdf()
    conn.close()
    
    if df.empty:
        raise ValueError(f"用户 {userid} 在最近 {days} 天内没有数据")
    
    # 4. 确保时间列为datetime类型（已经是本地时间）
    df['ts'] = pd.to_datetime(df['ts'])
    
    # 5. 创建图表
    fig, axes = plt.subplots(2, 2, figsize=figsize, dpi=dpi)
    # 明确使用已加载的字体属性，进一步避免渲染时回退
    fig.suptitle(
        f'用户情绪分析 - {userid} (最近{days}天)',
        fontsize=16,
        fontweight='bold',
        fontproperties=font_prop
    )
    
    # 子图1: Valence/Arousal/Stress 趋势
    ax1 = axes[0, 0]
    ax1.plot(df['ts'], df['valence'], label='Valence (效价)', marker='o', linewidth=2)
    ax1.plot(df['ts'], df['arousal'], label='Arousal (唤醒度)', marker='s', linewidth=2)
    ax1.plot(df['ts'], df['stress'], label='Stress (压力)', marker='^', linewidth=2)
    ax1.set_xlabel('时间', fontproperties=font_prop)
    ax1.set_ylabel('分数 (0-1)', fontproperties=font_prop)
    ax1.set_title('情绪维度趋势', fontproperties=font_prop)
    ax1.legend(prop=font_prop)
    ax1.grid(True, alpha=0.3)
    ax1.tick_params(axis='x', rotation=45)
    for lab in ax1.get_xticklabels():
        try:
            lab.set_fontproperties(font_prop)
        except Exception:
            pass
    for lab in ax1.get_yticklabels():
        try:
            lab.set_fontproperties(font_prop)
        except Exception:
            pass
    
    # 子图2: Dominance 趋势
    ax2 = axes[0, 1]
    ax2.plot(df['ts'], df['dominance'], label='Dominance (支配度)', 
             marker='D', color='purple', linewidth=2)
    ax2.set_xlabel('时间', fontproperties=font_prop)
    ax2.set_ylabel('分数 (0-1)', fontproperties=font_prop)
    ax2.set_title('支配度趋势', fontproperties=font_prop)
    ax2.legend(prop=font_prop)
    ax2.grid(True, alpha=0.3)
    ax2.tick_params(axis='x', rotation=45)
    for lab in ax2.get_xticklabels():
        try:
            lab.set_fontproperties(font_prop)
        except Exception:
            pass
    for lab in ax2.get_yticklabels():
        try:
            lab.set_fontproperties(font_prop)
        except Exception:
            pass
    
    # 子图3: 情感分布（Sentiment）
    ax3 = axes[1, 0]
    sentiment_counts = df['sentiment'].value_counts()
    colors = {'positive': '#4CAF50', 'negative': '#F44336', 'neutral': '#FFC107'}
    bar_colors = [colors.get(s, '#9E9E9E') for s in sentiment_counts.index]
    ax3.bar(sentiment_counts.index, sentiment_counts.values, color=bar_colors)
    ax3.set_xlabel('情感类型', fontproperties=font_prop)
    ax3.set_ylabel('数量', fontproperties=font_prop)
    ax3.set_title('情感分布统计', fontproperties=font_prop)
    ax3.grid(True, axis='y', alpha=0.3)
    
    # 在柱状图上显示数值
    for i, (idx, val) in enumerate(sentiment_counts.items()):
        ax3.text(i, val, str(val), ha='center', va='bottom', fontweight='bold', fontproperties=font_prop)
    for lab in ax3.get_xticklabels():
        try:
            lab.set_fontproperties(font_prop)
        except Exception:
            pass
    for lab in ax3.get_yticklabels():
        try:
            lab.set_fontproperties(font_prop)
        except Exception:
            pass
    
    # 子图4: 数据统计信息
    ax4 = axes[1, 1]
    ax4.axis('off')
    
    # 计算统计信息
    stats_text = f"""
    📊 数据统计
    
    总记录数: {len(df)}
    时间范围: {df['ts'].min().strftime('%Y-%m-%d %H:%M')} 
              至 {df['ts'].max().strftime('%Y-%m-%d %H:%M')}
    
    📈 平均值
    • Valence:    {df['valence'].mean():.3f}
    • Arousal:    {df['arousal'].mean():.3f}
    • Dominance:  {df['dominance'].mean():.3f}
    • Stress:     {df['stress'].mean():.3f}
    
    😊 情感分布
    """
    
    for sentiment, count in sentiment_counts.items():
        percentage = count / len(df) * 100
        stats_text += f"• {sentiment.capitalize()}: {count} ({percentage:.1f}%)\n    "
    
    ax4.text(0.1, 0.9, stats_text, transform=ax4.transAxes,
             fontsize=11, verticalalignment='top',
             bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5),
             fontproperties=font_prop)
    
    # 6. 保存图表
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f"emotion_chart_{userid}_{timestamp}.png"
    filepath = output_path / filename
    
    plt.tight_layout()
    plt.savefig(filepath, dpi=dpi, bbox_inches='tight')
    plt.close(fig)
    
    # 7. 返回绝对路径
    absolute_path = filepath.resolve()
    print(f"✓ 图表已生成: {absolute_path}")
    
    return str(absolute_path)


def compute_user_emotion_averages(
    userid: str,
    days: int = 7,
    db_path: str = 'data/sentra_emo.duckdb',
    min_score: float = 0.05,
) -> pd.DataFrame:
    """
    计算用户在最近N天内每个情绪标签的平均分与出现次数。

    数据来源：events.emotions（优先）/ events.top_emotions。按阈值过滤微小分数，避免大量接近0的残留值导致“均值≈0但覆盖≈100%”。

    Returns:
        pandas.DataFrame：列包含 [emotion, avg_score, count, coverage]
    """
    db_file = Path(db_path)
    if not db_file.exists():
        raise FileNotFoundError(f"数据库文件不存在: {db_path}")

    conn = duckdb.connect(str(db_file))
    cutoff_time = datetime.now() - timedelta(days=days)

    # 只取必要列，减少内存（同时取 emotions 与 top_emotions，优先使用 emotions）
    df = conn.execute(
        """
        SELECT ts, emotions, top_emotions, valence, arousal, dominance, stress
        FROM events
        WHERE userid = ? AND ts >= ?
        ORDER BY ts ASC
        """,
        [userid, cutoff_time.isoformat()],
    ).fetchdf()
    conn.close()

    if df.empty:
        raise ValueError(f"用户 {userid} 在最近 {days} 天内没有数据")

    total_events = len(df)

    # 展开 emotions（若为空则回退到 top_emotions）
    rows = []
    for _, r in df.iterrows():
        items = r.get('emotions')
        if not items or (isinstance(items, str) and not items.strip()):
            items = r.get('top_emotions')
        if isinstance(items, str):
            try:
                import json as _json
                items = _json.loads(items)
            except Exception:
                items = []
        for it in (items or []):
            try:
                # 支持 [label, score] 或 {label, score}
                if isinstance(it, (list, tuple)) and len(it) >= 2:
                    lab, sc = str(it[0]), float(it[1])
                elif isinstance(it, dict):
                    lab, sc = str(it.get('label')), float(it.get('score', 0.0))
                else:
                    continue
                if lab:
                    rows.append((lab, sc))
            except Exception:
                continue

    if not rows:
        # 没有可用的情绪标签
        return pd.DataFrame(columns=['emotion', 'avg_score', 'count', 'coverage'])

    emo_df = pd.DataFrame(rows, columns=['emotion', 'score'])
    try:
        min_score = float(min_score)
    except Exception:
        min_score = 0.05
    # 仅统计分数达到阈值的出现
    emo_df = emo_df[emo_df['score'] >= float(min_score)]
    if emo_df.empty:
        return pd.DataFrame(columns=['emotion', 'avg_score', 'count', 'coverage'])
    agg = (
        emo_df
        .groupby('emotion', as_index=False)
        .agg(avg_score=('score', 'mean'), count=('score', 'size'))
        .sort_values('avg_score', ascending=False)
    )
    agg['coverage'] = (agg['count'] / float(total_events)).clip(upper=1.0)
    # 排序时优先平均分，其次出现次数
    agg = agg.sort_values(['avg_score', 'count'], ascending=[False, False]).reset_index(drop=True)
    return agg


def generate_user_emotion_table_chart(
    userid: str,
    days: int = 7,
    output_dir: str = 'output',
    font_path: str = None,
    db_path: str = 'data/sentra_emo.duckdb',
    top_k: int = 15,
    dpi: int = 120,
    min_score: float = 0.05,
) -> str:
    """
    生成“每个情绪标签的平均分表格”图片，返回图片绝对路径。
    """
    # 字体
    font_prop = load_custom_font(font_path)
    configure_matplotlib_font(font_prop)

    # 数据
    agg = compute_user_emotion_averages(userid=userid, days=days, db_path=db_path, min_score=min_score)
    if agg.empty:
        raise ValueError(f"用户 {userid} 在最近 {days} 天内没有可用情绪标签数据")

    show = agg.head(max(1, int(top_k))).copy()
    show['avg_score'] = show['avg_score'].map(lambda x: f"{x:.3f}")
    show['coverage'] = show['coverage'].map(lambda x: f"{x*100:.1f}%")

    # 绘制表格
    fig, ax = plt.subplots(figsize=(10, 0.5 + 0.35 * len(show)), dpi=dpi)
    ax.axis('off')
    ax.set_title(
        f'用户 {userid} · 最近{days}天 · 情绪均值表 (Top {len(show)})',
        fontsize=14,
        pad=10,
        fontproperties=font_prop
    )

    table = ax.table(
        cellText=show[['emotion', 'avg_score', 'count', 'coverage']].values,
        colLabels=['情绪', '平均分', '出现次数', '覆盖率'],
        loc='center',
        cellLoc='center',
        colLoc='center',
    )
    table.auto_set_font_size(False)
    table.set_fontsize(11)
    table.scale(1, 1.2)
    try:
        for cell in table.get_celld().values():
            cell.get_text().set_fontproperties(font_prop)
    except Exception:
        pass

    # 保存
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    fp = output_path / f"emotion_table_{userid}_{ts}.png"
    plt.tight_layout()
    plt.savefig(fp, bbox_inches='tight', dpi=dpi)
    plt.close(fig)
    abs_fp = fp.resolve()
    print(f"✓ 表格已生成: {abs_fp}")
    return str(abs_fp)

def generate_sentiment_distribution_chart(
    days: int = 7,
    output_dir: str = 'output',
    font_path: str = None,
    db_path: str = 'data/sentra_emo.duckdb',
    figsize: tuple = (10, 6),
    dpi: int = 100
) -> str:
    """
    生成所有用户的情感分布统计图
    
    Args:
        days: 查询最近N天的数据
        output_dir: 输出目录
        font_path: 字体文件路径
        db_path: 数据库路径
        figsize: 图表尺寸
        dpi: 图片分辨率
    
    Returns:
        str: 生成的图片绝对路径
    """
    # 1. 加载字体
    font_prop = load_custom_font(font_path)
    configure_matplotlib_font(font_prop)
    
    # 2. 连接数据库
    conn = duckdb.connect(db_path)
    cutoff_time = datetime.now() - timedelta(days=days)
    
    query = """
        SELECT 
            sentiment,
            COUNT(*) as count,
            AVG(valence) as avg_valence,
            AVG(stress) as avg_stress
        FROM events
        WHERE ts >= ?
        GROUP BY sentiment
        ORDER BY count DESC
    """
    
    df = conn.execute(query, [cutoff_time.isoformat()]).fetchdf()
    conn.close()
    
    if df.empty:
        raise ValueError(f"最近 {days} 天内没有数据")
    
    # 3. 创建图表
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=figsize, dpi=dpi)
    fig.suptitle(
        f'情感分布统计 (最近{days}天)',
        fontsize=14,
        fontweight='bold',
        fontproperties=font_prop
    )
    
    # 子图1: 数量分布
    colors = {'positive': '#4CAF50', 'negative': '#F44336', 'neutral': '#FFC107'}
    bar_colors = [colors.get(s, '#9E9E9E') for s in df['sentiment']]
    
    ax1.bar(df['sentiment'], df['count'], color=bar_colors)
    ax1.set_xlabel('情感类型', fontproperties=font_prop)
    ax1.set_ylabel('数量', fontproperties=font_prop)
    ax1.set_title('情感数量分布', fontproperties=font_prop)
    ax1.grid(True, axis='y', alpha=0.3)
    
    for i, row in df.iterrows():
        ax1.text(i, row['count'], str(row['count']), 
                ha='center', va='bottom', fontweight='bold', fontproperties=font_prop)
    for lab in ax1.get_xticklabels():
        try:
            lab.set_fontproperties(font_prop)
        except Exception:
            pass
    for lab in ax1.get_yticklabels():
        try:
            lab.set_fontproperties(font_prop)
        except Exception:
            pass
    
    # 子图2: 平均指标
    x = range(len(df))
    width = 0.35
    ax2.bar([i - width/2 for i in x], df['avg_valence'], width, 
            label='平均Valence', color='#2196F3')
    ax2.bar([i + width/2 for i in x], df['avg_stress'], width, 
            label='平均Stress', color='#FF5722')
    ax2.set_xlabel('情感类型', fontproperties=font_prop)
    ax2.set_ylabel('分数', fontproperties=font_prop)
    ax2.set_title('平均情绪指标', fontproperties=font_prop)
    ax2.set_xticks(x)
    ax2.set_xticklabels(df['sentiment'])
    ax2.legend(prop=font_prop)
    ax2.grid(True, axis='y', alpha=0.3)
    for lab in ax2.get_xticklabels():
        try:
            lab.set_fontproperties(font_prop)
        except Exception:
            pass
    for lab in ax2.get_yticklabels():
        try:
            lab.set_fontproperties(font_prop)
        except Exception:
            pass
    
    # 4. 保存图表
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f"sentiment_distribution_{timestamp}.png"
    filepath = output_path / filename
    
    plt.tight_layout()
    plt.savefig(filepath, dpi=dpi, bbox_inches='tight')
    plt.close(fig)
    
    absolute_path = filepath.resolve()
    print(f"✓ 图表已生成: {absolute_path}")
    
    return str(absolute_path)


if __name__ == '__main__':
    """命令行测试示例"""
    import sys
    
    try:
        # 生成用户情绪图表
        print("生成用户情绪图表...")
        chart1 = generate_user_emotion_chart(
            userid='u_demo_001',
            days=7,
            output_dir='output'
        )
        print(f"✓ 用户图表: {chart1}\n")
        
        # 生成情感分布图表
        print("生成情感分布图表...")
        chart2 = generate_sentiment_distribution_chart(
            days=7,
            output_dir='output'
        )
        print(f"✓ 分布图表: {chart2}\n")
        
        print("=" * 60)
        print("✓ 所有图表生成完成！")
        
    except Exception as e:
        print(f"✗ 错误: {e}", file=sys.stderr)
        sys.exit(1)
