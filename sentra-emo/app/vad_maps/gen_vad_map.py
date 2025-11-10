#!/usr/bin/env python3
# coding: utf-8
"""
Generate vad_map.json from a VAD lexicon and a curated synonyms mapping.

Usage examples:
  # Minimal (auto-discover lexicon in app/vad_maps/lexicons and default synonyms):
  python app/vad_maps/gen_vad_map.py --out-model models/emotion/Chinese-Emotion-Small

  # Explicit files:
  python app/vad_maps/gen_vad_map.py \
      --lexicon path/to/NRC-VAD-Lexicon.csv \
      --synonyms app/vad_maps/synonyms.json \
      --out models/emotion/Chinese-Emotion-Small/vad_map.json

Notes:
- Lexicon file should contain headers with columns like: Word, Valence, Arousal, Dominance
- Values are expected in [0,1]. If not, the script will try to normalize typical 1..9 scales to 0..1.
- Synonyms JSON is a mapping: { label: ["syn1", "syn2", ...], ... }
- The script computes the median (default) or mean per label across found synonyms.
- Missing labels fall back to existing entries from --fallback (if provided), or are skipped.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import mean, median
from typing import Dict, List, Tuple


def _auto_delimiter(sample: str) -> str:
    # simple heuristic: prefer tab if present, else comma
    return "\t" if "\t" in sample and "," not in sample else ","


def _normalize_scale(v: float) -> float:
    # Normalize to [0,1] if input looks like 1..9 scale
    if v is None or not math.isfinite(v):
        return 0.5
    # Already 0..1
    if 0.0 <= v <= 1.0:
        return float(v)
    # Likely -1..1 scale (e.g., NRC VAD v2.x): map to 0..1
    if -1.0 <= v <= 1.0:
        return float((v + 1.0) / 2.0)
    # common Warriner 1..9 scale -> map linearly to 0..1
    if 1.0 <= v <= 9.0:
        return float((v - 1.0) / 8.0)
    # otherwise clamp
    return float(min(1.0, max(0.0, v)))


def load_lexicon(path: Path) -> Dict[str, Tuple[float, float, float]]:
    if not path.exists():
        raise FileNotFoundError(f"Lexicon not found: {path}")
    text = path.read_text(encoding="utf-8", errors="ignore")
    delim = _auto_delimiter(text.splitlines()[0] if text else ",")
    # Try csv.DictReader
    rows = list(csv.DictReader(text.splitlines(), delimiter=delim))
    # Normalize headers
    def norm_key(k: str) -> str:
        return (k or "").strip().lower()

    # Try to resolve column names
    header_map = {norm_key(k): k for k in (rows[0].keys() if rows else [])}
    def find_col(*cands: str) -> str | None:
        for c in cands:
            if c in header_map:
                return header_map[c]
        return None

    col_word = find_col("word", "lemma", "term")
    col_v = find_col("valence", "v")
    col_a = find_col("arousal", "a")
    col_d = find_col("dominance", "d")
    if not (col_word and col_v and col_a and col_d):
        raise ValueError("Could not find required columns (word,valence,arousal,dominance) in lexicon")

    out: Dict[str, Tuple[float, float, float]] = {}
    for r in rows:
        w = str(r.get(col_word, "")).strip().lower()
        if not w:
            continue
        try:
            v = _normalize_scale(float(str(r.get(col_v, "")).strip()))
            a = _normalize_scale(float(str(r.get(col_a, "")).strip()))
            d = _normalize_scale(float(str(r.get(col_d, "")).strip()))
        except Exception:
            continue
        out[w] = (v, a, d)
    if not out:
        raise ValueError("Empty lexicon after parsing")
    return out


def load_synonyms(path: Path) -> Dict[str, List[str]]:
    if not path.exists():
        raise FileNotFoundError(f"Synonyms file not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    out: Dict[str, List[str]] = {}
    for k, arr in data.items():
        toks = []
        for t in arr or []:
            s = str(t).strip().lower()
            if s:
                toks.append(s)
        if toks:
            out[str(k).strip()] = toks
    return out


def aggregate(vals: List[Tuple[float, float, float]], method: str = "median") -> Tuple[float, float, float]:
    if not vals:
        return (0.5, 0.5, 0.5)
    vs = [v for v, _, _ in vals]
    as_ = [a for _, a, _ in vals]
    ds = [d for _, _, d in vals]
    if method == "mean":
        return (float(mean(vs)), float(mean(as_)), float(mean(ds)))
    # default: median (robust to outliers)
    return (float(median(vs)), float(median(as_)), float(median(ds)))


def build_map(lex: Dict[str, Tuple[float, float, float]], syn: Dict[str, List[str]], *, method: str = "median", min_count: int = 1) -> Dict[str, Tuple[float, float, float]]:
    result: Dict[str, Tuple[float, float, float]] = {}
    coverage: Dict[str, int] = {}
    for label, terms in syn.items():
        vals: List[Tuple[float, float, float]] = []
        for t in terms:
            triple = lex.get(t)
            if triple is None:
                # simple heuristic: try plural/suffix variants
                for alt in (t.rstrip('s'), t.rstrip('ed'), t.rstrip('ing')):
                    if alt and alt in lex:
                        triple = lex[alt]
                        break
            if triple is not None:
                vals.append(triple)
        if len(vals) >= min_count:
            result[label] = aggregate(vals, method=method)
            coverage[label] = len(vals)
    return result


def _project_root() -> Path:
    # .../app/vad_maps/gen_vad_map.py -> project root is parents[2]
    return Path(__file__).resolve().parents[2]


def _default_synonyms_path() -> Path:
    root = _project_root()
    primary = root / "app" / "vad_maps" / "synonyms.json"
    if primary.exists():
        return primary
    fallback = root / "app" / "vad_maps" / "synonyms.example.json"
    return fallback


def _discover_lexicon(search_dir: Path) -> Path | None:
    if not search_dir.exists():
        return None
    cands: List[Path] = []
    for p in search_dir.iterdir():
        if not p.is_file():
            continue
        name = p.name.lower()
        if any(name.endswith(ext) for ext in (".txt", ".csv", ".tsv")):
            cands.append(p)
    # prefer files containing common keywords
    def _score(p: Path) -> int:
        n = p.name.lower()
        score = 0
        if "vad" in n:
            score += 3
        if "nrc" in n:
            score += 2
        if "lexicon" in n:
            score += 1
        return score
    if not cands:
        return None
    cands_sorted = sorted(cands, key=lambda p: (-_score(p), p.name.lower()))
    return cands_sorted[0]


def main():
    ap = argparse.ArgumentParser(description="Generate vad_map.json from VAD lexicon and synonyms")
    ap.add_argument("--lexicon", required=False, type=Path, help="Path to VAD lexicon CSV/TSV (e.g., NRC-VAD)")
    ap.add_argument("--lexicons-dir", required=False, type=Path, help="Directory to auto-discover lexicon (default: app/vad_maps/lexicons)")
    ap.add_argument("--synonyms", required=False, type=Path, help="Path to synonyms JSON mapping (default: app/vad_maps/synonyms.json or synonyms.example.json)")
    ap.add_argument("--out", required=False, type=Path, help="Output vad_map.json path")
    ap.add_argument("--out-model", required=False, type=Path, help="Model directory to write {model_dir}/vad_map.json")
    ap.add_argument("--method", choices=["median", "mean"], default="median")
    ap.add_argument("--min_count", type=int, default=1, help="Min # of matched synonyms to accept a label")
    ap.add_argument("--fallback", type=Path, default=None, help="Optional existing vad_map.json to use for missing labels")
    args = ap.parse_args()

    # Resolve defaults
    if not args.lexicons_dir:
        args.lexicons_dir = _project_root() / "app" / "vad_maps" / "lexicons"
    if not args.lexicon:
        auto_lex = _discover_lexicon(args.lexicons_dir)
        if not auto_lex:
            raise FileNotFoundError(f"No lexicon specified and none found under {args.lexicons_dir}")
        args.lexicon = auto_lex
        print(f"Auto-discovered lexicon: {args.lexicon}")
    if not args.synonyms:
        args.synonyms = _default_synonyms_path()
        print(f"Using synonyms: {args.synonyms}")
    if not args.out and args.out_model:
        args.out = args.out_model / "vad_map.json"
        print(f"Output will be written to: {args.out}")
    if not args.out:
        raise ValueError("Please specify --out or --out-model")

    lex = load_lexicon(args.lexicon)
    syn = load_synonyms(args.synonyms)

    gen = build_map(lex, syn, method=args.method, min_count=max(1, args.min_count))

    if args.fallback and args.fallback.exists():
        try:
            fb = json.loads(args.fallback.read_text(encoding="utf-8"))
        except Exception:
            fb = {}
        for k, v in fb.items():
            if k not in gen:
                try:
                    vv = tuple(float(x) for x in v)
                    if len(vv) == 3:
                        gen[k] = vv  # fill missing label from fallback
                except Exception:
                    continue

    # round to 2 decimals for readability
    pretty = {k: [round(v, 2), round(a, 2), round(d, 2)] for k, (v, a, d) in gen.items()}
    args.out.write_text(json.dumps(pretty, ensure_ascii=False, indent=2), encoding="utf-8")

    # Print a small coverage report
    all_labels = list(syn.keys())
    found = set(pretty.keys())
    missing = [k for k in all_labels if k not in found]
    print(f"Generated {len(pretty)} labels to {args.out}")
    if missing:
        print(f"Missing {len(missing)} labels (not enough lexicon hits or absent): {', '.join(missing[:10])}{'...' if len(missing)>10 else ''}")


if __name__ == "__main__":
    main()
