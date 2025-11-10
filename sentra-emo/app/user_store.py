import os
import json
import time
import hashlib
import threading
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime, timezone
import duckdb
import math
import urllib.request
import urllib.error

from .config import (
    get_user_store_dir,
    get_user_fast_half_life_sec,
    get_user_slow_half_life_sec,
    get_user_adapt_gain,
    get_user_top_emotions,
    get_mbti_classifier,
    get_mbti_external_url,
    get_mbti_ie_a_low,
    get_mbti_ie_a_high,
    get_mbti_tf_pos_low,
    get_mbti_tf_pos_high,
    get_mbti_sn_vstd_low,
    get_mbti_sn_vstd_high,
    get_mbti_jp_astd_low,
    get_mbti_jp_astd_high,
    get_mbti_pos_v_cut,
    get_mbti_neg_v_cut,
    get_analytics_max_events,
)
from .schemas import VADResult, StressResult, LabelScore, UserState




def _iso_now() -> str:
    """返回本地时间的ISO格式字符串（服务器本地时区）"""
    # 使用服务器本地时间（不强制指定为北京时间）
    return datetime.now().isoformat()


def _safe_userid(uid: str) -> str:
    uid = (uid or "").strip()
    if not uid:
        return hashlib.sha1(b"anon").hexdigest()[:16]
    allowed = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in uid)
    if not allowed:
        allowed = hashlib.sha1(uid.encode("utf-8", errors="ignore")).hexdigest()
    # Prefix with short hash to avoid collisions on sanitized ids
    short = hashlib.sha1(uid.encode("utf-8", errors="ignore")).hexdigest()[:8]
    return f"{short}_{allowed}"


class UserStore:
    def __init__(self):
        self.root = get_user_store_dir()
        self.db_path = self.root / "sentra_emo.duckdb"
        self.users_dir = self.root / "users"
        self._init_once_lock = threading.Lock()
        self._inited = False
        self._conn_lock = threading.Lock()

    def _ensure_inited(self) -> None:
        if self._inited:
            return
        with self._init_once_lock:
            if self._inited:
                return
            self.root.mkdir(parents=True, exist_ok=True)
            # Initialize DuckDB and create tables if not exists
            with self._get_conn() as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS events (
                        ts TIMESTAMP,
                        userid VARCHAR,
                        username VARCHAR,
                        text VARCHAR,
                        sentiment VARCHAR,
                        valence DOUBLE,
                        arousal DOUBLE,
                        dominance DOUBLE,
                        stress DOUBLE,
                        top_emotions JSON
                    )
                """)
                conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_events_userid_ts 
                    ON events(userid, ts DESC)
                """)
                # Add new column to store full emotion distribution per event
                try:
                    conn.execute("""
                        ALTER TABLE events ADD COLUMN emotions JSON
                    """)
                except Exception:
                    # Column may already exist in existing databases
                    pass
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS user_state (
                        userid VARCHAR,
                        username VARCHAR,
                        count BIGINT,
                        vad_valence DOUBLE,
                        vad_arousal DOUBLE,
                        vad_dominance DOUBLE,
                        baseline_valence DOUBLE,
                        baseline_arousal DOUBLE,
                        baseline_dominance DOUBLE,
                        stress DOUBLE,
                        stress_level VARCHAR,
                        top_emotions JSON,
                        top_emotions_fast JSON,
                        updated_at TIMESTAMP,
                        updated_ts DOUBLE,
                        stress_slow DOUBLE,
                        trend_valence DOUBLE,
                        trend_arousal DOUBLE,
                        trend_dominance DOUBLE,
                        stress_trend DOUBLE
                    )
                """)
                conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_user_state_userid 
                    ON user_state(userid)
                """)
            self._inited = True

    def _get_conn(self):
        """Get thread-safe DuckDB connection."""
        return duckdb.connect(str(self.db_path))

    def _ensure_schema(self, conn) -> None:
        """Idempotently ensure all required tables/columns/indexes exist.
        Call this before any operation so we recover if DB file was deleted.
        """
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    ts TIMESTAMP,
                    userid VARCHAR,
                    username VARCHAR,
                    text VARCHAR,
                    sentiment VARCHAR,
                    valence DOUBLE,
                    arousal DOUBLE,
                    dominance DOUBLE,
                    stress DOUBLE,
                    top_emotions JSON
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_events_userid_ts 
                ON events(userid, ts DESC)
                """
            )
            # Add new column to store full emotion distribution per event
            try:
                conn.execute("ALTER TABLE events ADD COLUMN emotions JSON")
            except Exception:
                pass
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_state (
                    userid VARCHAR,
                    username VARCHAR,
                    count BIGINT,
                    vad_valence DOUBLE,
                    vad_arousal DOUBLE,
                    vad_dominance DOUBLE,
                    baseline_valence DOUBLE,
                    baseline_arousal DOUBLE,
                    baseline_dominance DOUBLE,
                    stress DOUBLE,
                    stress_level VARCHAR,
                    top_emotions JSON,
                    top_emotions_fast JSON,
                    updated_at TIMESTAMP,
                    updated_ts DOUBLE,
                    stress_slow DOUBLE,
                    trend_valence DOUBLE,
                    trend_arousal DOUBLE,
                    trend_dominance DOUBLE,
                    stress_trend DOUBLE
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_user_state_userid 
                ON user_state(userid)
                """
            )
            # Backfill new columns for existing DBs
            for ddl in [
                "ALTER TABLE user_state ADD COLUMN top_emotions_fast JSON",
                "ALTER TABLE user_state ADD COLUMN stress_slow DOUBLE",
                "ALTER TABLE user_state ADD COLUMN trend_valence DOUBLE",
                "ALTER TABLE user_state ADD COLUMN trend_arousal DOUBLE",
                "ALTER TABLE user_state ADD COLUMN trend_dominance DOUBLE",
                "ALTER TABLE user_state ADD COLUMN stress_trend DOUBLE",
            ]:
                try:
                    conn.execute(ddl)
                except Exception:
                    pass
        except Exception:
            # Best-effort; callers will surface detailed errors
            pass

    def _user_path(self, userid: str) -> Path:
        uid = _safe_userid(userid)
        return self.users_dir / f"{uid}.json"

    def _alpha(self, dt_sec: float, half_life_sec: float) -> float:
        if half_life_sec <= 0:
            return 1.0
        # EMA decay by half-life: alpha = 1 - 2^(-dt/half)
        try:
            return 1.0 - pow(2.0, -float(dt_sec) / float(half_life_sec))
        except Exception:
            return 0.5

    def append_event(self, userid: str, username: Optional[str], text: str, sentiment_label: str,
                     vad: VADResult, stress: StressResult, emotions: List[LabelScore]) -> None:
        self._ensure_inited()
        ts = _iso_now()
        # Prepare top emotions summary as JSON
        top_e = [[e.label, float(e.score)] for e in emotions[: get_user_top_emotions()]]
        all_e = [[e.label, float(e.score)] for e in emotions]
        # Insert into DuckDB (try with emotions column; fallback to legacy schema)
        with self._get_conn() as conn:
            self._ensure_schema(conn)
            try:
                conn.execute("""
                    INSERT INTO events (
                        ts, userid, username, text, sentiment,
                        valence, arousal, dominance, stress,
                        top_emotions, emotions
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, [
                    ts,
                    userid or "",
                    username or "",
                    (text or "").replace("\n", " ").replace("\r", " ")[:5000],
                    sentiment_label or "",
                    float(getattr(vad, "valence", 0.0) or 0.0),
                    float(getattr(vad, "arousal", 0.0) or 0.0),
                    float(getattr(vad, "dominance", 0.0) or 0.0),
                    float(getattr(stress, "score", 0.0) or 0.0),
                    json.dumps(top_e, ensure_ascii=False),
                    json.dumps(all_e, ensure_ascii=False),
                ])
            except Exception:
                # Fallback for old DB without 'emotions' column
                conn.execute("""
                    INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, [
                    ts,
                    userid or "",
                    username or "",
                    (text or "").replace("\n", " ").replace("\r", " ")[:5000],
                    sentiment_label or "",
                    float(getattr(vad, "valence", 0.0) or 0.0),
                    float(getattr(vad, "arousal", 0.0) or 0.0),
                    float(getattr(vad, "dominance", 0.0) or 0.0),
                    float(getattr(stress, "score", 0.0) or 0.0),
                    json.dumps(top_e, ensure_ascii=False),
                ])

    def load_user(self, userid: str) -> Optional[UserState]:
        self._ensure_inited()
        # Query from DuckDB user_state table
        with self._get_conn() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT userid, username, count,
                       vad_valence, vad_arousal, vad_dominance,
                       stress, stress_level, top_emotions, updated_at
                FROM user_state
                WHERE userid = ?
                """,
                [userid],
            ).fetchone()
        if not row:
            return None
        try:
            emotions: List[LabelScore] = []
            raw_emos = row[8]
            if raw_emos:
                try:
                    parsed = json.loads(raw_emos) if isinstance(raw_emos, str) else raw_emos
                except Exception:
                    parsed = []
                for e in parsed or []:
                    try:
                        emotions.append(LabelScore(label=str(e.get("label")), score=float(e.get("score", 0.0))))
                    except Exception:
                        continue
            return UserState(
                userid=str(row[0]),
                username=str(row[1]) if row[1] is not None else None,
                count=int(row[2] or 0),
                vad=VADResult(
                    valence=float(row[3] or 0.5),
                    arousal=float(row[4] or 0.5),
                    dominance=float(row[5] or 0.5),
                    method="ema",
                ),
                emotions=emotions,
                stress=StressResult(score=float(row[6] or 0.3), level=str(row[7] or "low")),
                updated_at=str(row[9]) if row[9] else _iso_now(),
            )
        except Exception:
            return None

    def update_user(self, userid: str, username: Optional[str], text: str,
                    sentiment_label: str, vad: VADResult, stress: StressResult,
                    emotions: List[LabelScore]) -> UserState:
        self._ensure_inited()
        now_iso = _iso_now()
        # 使用服务器本地时间戳
        now = float(time.time())
        fast_half = float(get_user_fast_half_life_sec())
        slow_half = float(get_user_slow_half_life_sec())
        adapt_gain = float(get_user_adapt_gain())

        with self._conn_lock:
            # Load previous state from DuckDB
            with self._get_conn() as conn:
                self._ensure_schema(conn)
                prev = conn.execute(
                    """
                    SELECT count,
                           vad_valence, vad_arousal, vad_dominance,
                           baseline_valence, baseline_arousal, baseline_dominance,
                           stress, stress_level, top_emotions, updated_ts,
                           top_emotions_fast, stress_slow
                    FROM user_state
                    WHERE userid = ?
                    """,
                    [userid],
                ).fetchone()

            cur: Dict = {}
            if prev:
                cur["count"] = int(prev[0] or 0)
                cur["vad"] = {
                    "valence": float(prev[1] or 0.5),
                    "arousal": float(prev[2] or 0.5),
                    "dominance": float(prev[3] or 0.5),
                    "method": "ema",
                }
                cur["baseline_vad"] = {
                    "valence": float(prev[4] or 0.5),
                    "arousal": float(prev[5] or 0.5),
                    "dominance": float(prev[6] or 0.5),
                }
                cur["stress"] = {"score": float(prev[7] or 0.3), "level": str(prev[8] or "low")}
                try:
                    cur["emotions"] = json.loads(prev[9]) if isinstance(prev[9], str) else (prev[9] or [])
                except Exception:
                    cur["emotions"] = []
                cur["updated_ts"] = float(prev[10] or now)
            else:
                cur = {}

            last_ts = cur.get("updated_ts") or cur.get("updated_at")
            if isinstance(last_ts, (int, float)):
                last_time = float(last_ts)
            else:
                try:
                    last_time = datetime.fromisoformat(str(last_ts).replace("Z", "+00:00")).timestamp() if last_ts else now
                except Exception:
                    last_time = now
            dt = max(0.0, now - last_time)

            # Get old values or defaults
            old_vad = cur.get("vad") or {"valence": 0.5, "arousal": 0.5, "dominance": 0.5, "method": "ema"}
            old_base = cur.get("baseline_vad") or {"valence": 0.5, "arousal": 0.5, "dominance": 0.5}
            old_stress = cur.get("stress") or {"score": 0.3, "level": "low"}
            old_emos: Dict[str, float] = {e["label"]: float(e["score"]) for e in cur.get("emotions", []) if isinstance(e, dict) and "label" in e}

            a_fast_base = self._alpha(dt, fast_half)
            a_slow = self._alpha(dt, slow_half)

            # Update EMA VAD with adaptive fast alpha per dimension
            def _adapt(a_base: float, cur_value: float, old_fast_value: float) -> float:
                try:
                    eff = a_base * (1.0 + adapt_gain * abs(float(cur_value) - float(old_fast_value)))
                    if eff > 0.99:
                        eff = 0.99
                    if eff < 0.0:
                        eff = 0.0
                    return eff
                except Exception:
                    return a_base

            ov, oa, od = float(old_vad.get("valence", 0.5)), float(old_vad.get("arousal", 0.5)), float(old_vad.get("dominance", 0.5))
            cv, ca, cd = float(vad.valence), float(vad.arousal), float(vad.dominance)
            af_v = _adapt(a_fast_base, cv, ov)
            af_a = _adapt(a_fast_base, ca, oa)
            af_d = _adapt(a_fast_base, cd, od)
            new_v = ov + af_v * (cv - ov)
            new_a = oa + af_a * (ca - oa)
            new_d = od + af_d * (cd - od)
            new_vad = {"valence": new_v, "arousal": new_a, "dominance": new_d, "method": "ema"}

            # Update baseline (slower drift)
            bv, ba, bd = float(old_base.get("valence", 0.5)), float(old_base.get("arousal", 0.5)), float(old_base.get("dominance", 0.5))
            base_v = bv + a_slow * (cv - bv)
            base_a = ba + a_slow * (ca - ba)
            base_d = bd + a_slow * (cd - bd)
            new_base = {"valence": base_v, "arousal": base_a, "dominance": base_d}

            # Trends (fast - slow)
            trend_v = new_v - base_v
            trend_a = new_a - base_a
            trend_d = new_d - base_d

            # Update stress EMA fast/slow
            old_s_fast = float(old_stress.get("score", 0.3))
            old_s_slow = float(cur.get("stress_slow", old_s_fast)) if isinstance(cur.get("stress_slow", None), (int, float)) else old_s_fast
            af_s = _adapt(a_fast_base, float(stress.score), old_s_fast)
            new_s_fast = old_s_fast + af_s * (float(stress.score) - old_s_fast)
            new_s_slow = old_s_slow + a_slow * (float(stress.score) - old_s_slow)
            new_stress = {"score": new_s_fast, "level": str(stress.level)}
            stress_trend = new_s_fast - new_s_slow

            # Update emotions EMA: maintain slow and fast tracks
            # Parse previous slow (old_emos) and fast (old_emos_fast)
            cur_scores = {e.label: float(e.score) for e in emotions}
            try:
                old_fast_raw = prev[11] if prev and len(prev) > 11 else None
                if old_fast_raw:
                    old_emos_fast_list = json.loads(old_fast_raw) if isinstance(old_fast_raw, str) else (old_fast_raw or [])
                else:
                    old_emos_fast_list = []
            except Exception:
                old_emos_fast_list = []
            old_emos_fast: Dict[str, float] = {e.get("label"): float(e.get("score", 0.0)) for e in old_emos_fast_list if isinstance(e, dict) and e.get("label")}

            all_labels = set(old_emos.keys()) | set(old_emos_fast.keys()) | set(cur_scores.keys())
            upd_slow: Dict[str, float] = {}
            upd_fast: Dict[str, float] = {}
            for lab in all_labels:
                pv_slow = float(old_emos.get(lab, 0.0))
                pv_fast = float(old_emos_fast.get(lab, pv_slow))
                curv = float(cur_scores.get(lab, 0.0))
                upd_slow[lab] = pv_slow + a_slow * (curv - pv_slow)
                af_e = _adapt(a_fast_base, curv, pv_fast)
                upd_fast[lab] = pv_fast + af_e * (curv - pv_fast)
            # Keep top-N
            top_n = get_user_top_emotions()
            top_items_slow = sorted(upd_slow.items(), key=lambda kv: kv[1], reverse=True)[: max(1, int(top_n))]
            top_items_fast = sorted(upd_fast.items(), key=lambda kv: kv[1], reverse=True)[: max(1, int(top_n))]
            emos_list = [{"label": k, "score": float(v)} for k, v in top_items_slow if v > 1e-6]
            emos_list_fast = [{"label": k, "score": float(v)} for k, v in top_items_fast if v > 1e-6]

            # Persist to DuckDB (upsert)
            out_count = int(cur.get("count", 0)) + 1
            with self._get_conn() as conn:
                self._ensure_schema(conn)
                if prev:
                    conn.execute(
                        """
                        UPDATE user_state
                        SET username = ?,
                            count = ?,
                            vad_valence = ?, vad_arousal = ?, vad_dominance = ?,
                            baseline_valence = ?, baseline_arousal = ?, baseline_dominance = ?,
                            stress = ?, stress_level = ?, top_emotions = ?, top_emotions_fast = ?,
                            updated_at = ?, updated_ts = ?,
                            stress_slow = ?, trend_valence = ?, trend_arousal = ?, trend_dominance = ?, stress_trend = ?
                        WHERE userid = ?
                        """,
                        [
                            username,
                            out_count,
                            new_v, new_a, new_d,
                            base_v, base_a, base_d,
                            new_s_fast, str(stress.level), json.dumps(emos_list, ensure_ascii=False), json.dumps(emos_list_fast, ensure_ascii=False),
                            now_iso, now,
                            new_s_slow, trend_v, trend_a, trend_d, stress_trend,
                            userid,
                        ],
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO user_state (
                            userid, username, count,
                            vad_valence, vad_arousal, vad_dominance,
                            baseline_valence, baseline_arousal, baseline_dominance,
                            stress, stress_level, top_emotions, top_emotions_fast, updated_at, updated_ts,
                            stress_slow, trend_valence, trend_arousal, trend_dominance, stress_trend
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        [
                            userid, username, out_count,
                            new_v, new_a, new_d,
                            base_v, base_a, base_d,
                            new_s_fast, str(stress.level), json.dumps(emos_list, ensure_ascii=False), json.dumps(emos_list_fast, ensure_ascii=False),
                            now_iso, now,
                            new_s_slow, trend_v, trend_a, trend_d, stress_trend,
                        ],
                    )

        # Append event separately (coarse lock on events file)
        # 重要：事件记录应保存“本次分析的完整情绪分布”，而不是EMA后的top列表
        self.append_event(
            userid,
            username,
            text,
            sentiment_label,
            VADResult(**new_vad),
            StressResult(**new_stress),
            emotions,
        )

        # Return typed state
        return UserState(
            userid=userid,
            username=username,
            count=out_count,
            vad=VADResult(**new_vad),
            emotions=[LabelScore(**e) for e in emos_list],
            stress=StressResult(**new_stress),
            updated_at=now_iso,
        )

    def list_events(self, userid: str, limit: int = 200, start: Optional[str] = None, end: Optional[str] = None) -> List[Dict]:
        self._ensure_inited()
        with self._get_conn() as conn:
            self._ensure_schema(conn)
            where = "userid = ?"
            params: List = [userid]
            if start:
                where += " AND ts >= ?"
                params.append(start)
            if end:
                where += " AND ts <= ?"
                params.append(end)
            params.append(limit)
            result = conn.execute(f"""
                SELECT 
                    ts,
                    userid,
                    username,
                    text,
                    sentiment,
                    valence,
                    arousal,
                    dominance,
                    stress,
                    top_emotions
                FROM events
                WHERE {where}
                ORDER BY ts DESC
                LIMIT ?
            """, params).fetchall()
            
            cols = ["ts", "userid", "username", "text", "sentiment", 
                    "valence", "arousal", "dominance", "stress", "top_emotions"]
            out = []
            for row in result:
                d = dict(zip(cols, row))
                # Convert timestamp to ISO string if needed
                if d.get("ts"):
                    d["ts"] = str(d["ts"])
                # Parse JSON if string
                if isinstance(d.get("top_emotions"), str):
                    try:
                        d["top_emotions"] = json.loads(d["top_emotions"])
                    except Exception:
                        d["top_emotions"] = []
                out.append(d)
            # Return in chronological order (oldest first)
            return list(reversed(out))

    def export_user_parquet(self, userid: str, output_path: Optional[Path] = None) -> Path:
        """Export user events to Parquet file for easy visualization."""
        self._ensure_inited()
        if output_path is None:
            user_dir = self.users_dir / _safe_userid(userid)
            user_dir.mkdir(parents=True, exist_ok=True)
            output_path = user_dir / "events.parquet"
        
        with self._get_conn() as conn:
            self._ensure_schema(conn)
            # Use parameterized query for userid, but output_path must be literal
            conn.execute(f"""
                COPY (SELECT * FROM events WHERE userid = ? ORDER BY ts)
                TO '{output_path}' (FORMAT PARQUET)
            """, [userid])
        return output_path

    def get_analytics(self, userid: str, days: int = 30, start: Optional[str] = None, end: Optional[str] = None) -> Dict:
        """Get user analytics summary for dashboard."""
        self._ensure_inited()
        # Sanitize days parameter (must be integer)
        days = int(days) if days else 30
        with self._get_conn() as conn:
            self._ensure_schema(conn)
            if start or end:
                # Filter by explicit time range (ISO string recommended)
                stats = conn.execute(
                    """
                    SELECT 
                        COUNT(*) as total_events,
                        AVG(valence) as avg_valence,
                        AVG(arousal) as avg_arousal,
                        AVG(dominance) as avg_dominance,
                        AVG(stress) as avg_stress,
                        MIN(ts) as first_event,
                        MAX(ts) as last_event
                    FROM events
                    WHERE userid = ?
                      AND (? IS NULL OR ts >= ?)
                      AND (? IS NULL OR ts <= ?)
                    """,
                    [userid, start, start, end, end],
                ).fetchone()
                try:
                    rows = conn.execute(
                        """
                        SELECT ts, valence, arousal, dominance, emotions, top_emotions
                        FROM events
                        WHERE userid = ?
                          AND (? IS NULL OR ts >= ?)
                          AND (? IS NULL OR ts <= ?)
                        ORDER BY ts
                        LIMIT ?
                        """,
                        [userid, start, start, end, end, int(get_analytics_max_events())],
                    ).fetchall()
                except Exception:
                    rows = []
            else:
                # Get stats for last N days
                # Note: INTERVAL doesn't support parameterized queries, so we use f-string with validated int
                stats = conn.execute(f"""
                    SELECT 
                        COUNT(*) as total_events,
                        AVG(valence) as avg_valence,
                        AVG(arousal) as avg_arousal,
                        AVG(dominance) as avg_dominance,
                        AVG(stress) as avg_stress,
                        MIN(ts) as first_event,
                        MAX(ts) as last_event
                    FROM events
                    WHERE userid = ?
                      AND ts >= CURRENT_TIMESTAMP - INTERVAL {days} DAYS
                """, [userid]).fetchone()
                try:
                    rows = conn.execute(f"""
                        SELECT ts, valence, arousal, dominance, emotions, top_emotions
                        FROM events
                        WHERE userid = ?
                          AND ts >= CURRENT_TIMESTAMP - INTERVAL {days} DAYS
                        ORDER BY ts
                        LIMIT ?
                    """, [userid, int(get_analytics_max_events())]).fetchall()
                except Exception:
                    rows = []
            
            total = int(stats[0]) if stats and stats[0] else 0
            avg_v = float(stats[1]) if stats and stats[1] is not None else 0.5
            avg_a = float(stats[2]) if stats and stats[2] is not None else 0.5
            avg_d = float(stats[3]) if stats and stats[3] is not None else 0.5
            avg_s = float(stats[4]) if stats and stats[4] is not None else 0.3
            f_ts = str(stats[5]) if stats and stats[5] else None
            l_ts = str(stats[6]) if stats and stats[6] else None

            vs: List[float] = []
            as_: List[float] = []
            ds: List[float] = []
            pos_cut = float(get_mbti_pos_v_cut())
            neg_cut = float(get_mbti_neg_v_cut())
            pos_cnt = 0
            neg_cnt = 0
            label_sum: Dict[str, float] = {}
            for row in rows or []:
                try:
                    v = float(row[1]) if row[1] is not None else None
                    a = float(row[2]) if row[2] is not None else None
                    d = float(row[3]) if row[3] is not None else None
                    if v is not None:
                        vs.append(v)
                        if v >= pos_cut:
                            pos_cnt += 1
                        if v <= neg_cut:
                            neg_cnt += 1
                    if a is not None:
                        as_.append(a)
                    if d is not None:
                        ds.append(d)
                except Exception:
                    pass
                emo_raw = None
                try:
                    emo_raw = row[4]
                except Exception:
                    emo_raw = None
                if not emo_raw:
                    try:
                        emo_raw = row[5]
                    except Exception:
                        emo_raw = None
                try:
                    if isinstance(emo_raw, str):
                        emo = json.loads(emo_raw)
                    else:
                        emo = emo_raw
                except Exception:
                    emo = None
                if isinstance(emo, list):
                    for item in emo:
                        try:
                            if isinstance(item, (list, tuple)) and len(item) == 2:
                                lab = str(item[0])
                                sc = float(item[1])
                            elif isinstance(item, dict):
                                lab = str(item.get("label"))
                                sc = float(item.get("score", 0.0))
                            else:
                                continue
                            if not lab:
                                continue
                            label_sum[lab] = label_sum.get(lab, 0.0) + max(0.0, sc)
                        except Exception:
                            continue

            def _std(arr: List[float]) -> float:
                n = len(arr)
                if n <= 1:
                    return 0.0
                m = sum(arr) / n
                var = sum((x - m) * (x - m) for x in arr) / (n - 1)
                if var < 0:
                    var = 0.0
                try:
                    return math.sqrt(var)
                except Exception:
                    return 0.0

            v_std = _std(vs)
            a_std = _std(as_)
            d_std = _std(ds)
            n_events = len(vs)
            pos_ratio = (pos_cnt / n_events) if n_events > 0 else 0.0
            neg_ratio = (neg_cnt / n_events) if n_events > 0 else 0.0
            total_score = sum(label_sum.values())
            agg_emotions = []
            if total_score > 0:
                agg_emotions = sorted(
                    (
                        {"label": k, "score": float(v / total_score)}
                        for k, v in label_sum.items()
                        if v > 0
                    ),
                    key=lambda x: x["score"],
                    reverse=True,
                )
            dominant_emotion = (agg_emotions[0]["label"]) if agg_emotions else None

            def _heuristic_mbti() -> Dict:
                ie_low = float(get_mbti_ie_a_low())
                ie_high = float(get_mbti_ie_a_high())
                tf_low = float(get_mbti_tf_pos_low())
                tf_high = float(get_mbti_tf_pos_high())
                sn_low = float(get_mbti_sn_vstd_low())
                sn_high = float(get_mbti_sn_vstd_high())
                jp_low = float(get_mbti_jp_astd_low())
                jp_high = float(get_mbti_jp_astd_high())

                def _bin(value: float, low: float, high: float, lo_letter: str, hi_letter: str):
                    if value <= low:
                        return lo_letter, 1.0, low
                    if value >= high:
                        return hi_letter, 1.0, high
                    span = max(1e-6, high - low)
                    p = (value - low) / span
                    if p < 0.5:
                        conf = 1.0 - (p / 0.5)
                        return lo_letter, float(max(0.0, min(1.0, conf))), low
                    conf = (p - 0.5) / 0.5
                    return hi_letter, float(max(0.0, min(1.0, conf))), high

                ie_letter, ie_conf, ie_thr = _bin(avg_a, ie_low, ie_high, "I", "E")
                sn_letter, sn_conf, sn_thr = _bin(v_std, sn_low, sn_high, "S", "N")
                tf_letter, tf_conf, tf_thr = _bin(pos_ratio, tf_low, tf_high, "T", "F")
                jp_letter, jp_conf, jp_thr = _bin(a_std, jp_low, jp_high, "J", "P")

                dims = [
                    {"axis": "IE", "letter": ie_letter, "score": ie_conf, "metric": "avg_arousal", "value": avg_a, "low": ie_low, "high": ie_high},
                    {"axis": "SN", "letter": sn_letter, "score": sn_conf, "metric": "v_std", "value": v_std, "low": sn_low, "high": sn_high},
                    {"axis": "TF", "letter": tf_letter, "score": tf_conf, "metric": "pos_ratio", "value": pos_ratio, "low": tf_low, "high": tf_high},
                    {"axis": "JP", "letter": jp_letter, "score": jp_conf, "metric": "a_std", "value": a_std, "low": jp_low, "high": jp_high},
                ]
                mbti_type = f"{ie_letter}{sn_letter}{tf_letter}{jp_letter}"
                conf = sum(d["score"] for d in dims) / 4.0
                traits_map = {
                    "ISTJ": ["Practical", "Fact-oriented", "Dependable", "Orderly"],
                    "ISFJ": ["Caring", "Detail-oriented", "Responsible", "Supportive"],
                    "INFJ": ["Insightful", "Ideal-driven", "Empathetic", "Purpose-focused"],
                    "INTJ": ["Strategic", "Analytical", "Efficient", "Systems-oriented"],
                    "ISTP": ["Calm", "Hands-on", "Problem-solver", "Pragmatic"],
                    "ISFP": ["Gentle", "Aesthetic", "Experience-focused", "Adaptable"],
                    "INFP": ["Values-driven", "Idealistic", "Empathetic", "Reflective"],
                    "INTP": ["Logical", "Theoretical", "Curious", "Principle-seeking"],
                    "ESTP": ["Action-oriented", "Spontaneous", "Realistic", "Decisive"],
                    "ESFP": ["Enthusiastic", "Experiential", "Sociable", "Lively"],
                    "ENFP": ["Possibility-driven", "Creative", "Inspiring", "Expressive"],
                    "ENTP": ["Dialectical", "Innovative", "Contrarian", "Exploratory"],
                    "ESTJ": ["Organized", "Managerial", "Rule-focused", "Results-oriented"],
                    "ESFJ": ["Caring", "Cooperative", "Harmony-building", "Reliable"],
                    "ENFJ": ["Leadership", "Empathetic", "People-developing", "Persuasive"],
                    "ENTJ": ["Goal-oriented", "Decisive", "Commanding", "Organizer"],
                }
                traits = traits_map.get(mbti_type, [])
                parts: List[str] = []
                for d in dims:
                    try:
                        parts.append(f"{d['axis']}:{d['letter']} because {d['metric']}={d['value']:.2f} vs [{d['low']:.2f},{d['high']:.2f}]")
                    except Exception:
                        continue
                explain = "; ".join(parts)
                return {"type": mbti_type, "dimensions": dims, "method": "heuristic", "confidence": float(conf), "dominant_emotion": dominant_emotion, "traits_en": traits, "explain_en": explain}

            mbti_mode = get_mbti_classifier()
            mbti_res: Dict
            if mbti_mode == "external":
                url = get_mbti_external_url()
                payload = {
                    "userid": userid,
                    "avg_valence": avg_v,
                    "avg_arousal": avg_a,
                    "avg_dominance": avg_d,
                    "v_std": v_std,
                    "a_std": a_std,
                    "d_std": d_std,
                    "pos_ratio": pos_ratio,
                    "neg_ratio": neg_ratio,
                    "top_emotions": agg_emotions[: get_user_top_emotions()],
                    "total_events": total,
                }
                try:
                    if url:
                        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
                        with urllib.request.urlopen(req, timeout=5.0) as resp:
                            data = resp.read().decode("utf-8")
                            parsed = json.loads(data)
                            if isinstance(parsed, dict) and "type" in parsed:
                                mbti_res = parsed
                            else:
                                mbti_res = _heuristic_mbti()
                    else:
                        mbti_res = _heuristic_mbti()
                except Exception:
                    mbti_res = _heuristic_mbti()
            else:
                mbti_res = _heuristic_mbti()

            thr = {
                "IE_A": {"low": float(get_mbti_ie_a_low()), "high": float(get_mbti_ie_a_high())},
                "SN_VSTD": {"low": float(get_mbti_sn_vstd_low()), "high": float(get_mbti_sn_vstd_high())},
                "TF_POS": {"low": float(get_mbti_tf_pos_low()), "high": float(get_mbti_tf_pos_high())},
                "JP_ASTD": {"low": float(get_mbti_jp_astd_low()), "high": float(get_mbti_jp_astd_high())},
                "POS_V_CUT": float(pos_cut),
                "NEG_V_CUT": float(neg_cut),
                "VALENCE_BANDS": {"negative_max": float(neg_cut), "neutral_min": float(neg_cut), "neutral_max": float(pos_cut), "positive_min": float(pos_cut)},
                "STRESS_BANDS": {"low_max": 0.33, "medium_max": 0.66},
            }
            return {
                "total_events": total,
                "avg_valence": avg_v,
                "avg_arousal": avg_a,
                "avg_dominance": avg_d,
                "avg_stress": avg_s,
                "first_event": f_ts,
                "last_event": l_ts,
                "v_std": float(v_std),
                "a_std": float(a_std),
                "d_std": float(d_std),
                "pos_ratio": float(pos_ratio),
                "neg_ratio": float(neg_ratio),
                "top_emotions": agg_emotions[: get_user_top_emotions()],
                "mbti": mbti_res,
                "thresholds": thr,
            }
        return {
            "total_events": 0,
            "avg_valence": 0.5,
            "avg_arousal": 0.5,
            "avg_dominance": 0.5,
            "avg_stress": 0.3,
            "first_event": None,
            "last_event": None,
            "v_std": 0.0,
            "a_std": 0.0,
            "d_std": 0.0,
            "pos_ratio": 0.0,
            "neg_ratio": 0.0,
            "top_emotions": [],
            "mbti": {"type": "XXXX", "dimensions": [], "method": get_mbti_classifier(), "confidence": 0.0, "dominant_emotion": None},
        }


# Singleton accessor
_store: Optional[UserStore] = None


def get_store() -> UserStore:
    global _store
    if _store is None:
        _store = UserStore()
    return _store
