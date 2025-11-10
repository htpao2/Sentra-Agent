# VAD Lexicons Directory

Place your Valence/Arousal/Dominance (VAD) lexicon files here. The generator will auto-discover a lexicon in this folder when `--lexicon` is not specified.

Supported formats:
- CSV/TSV/TXT with header columns (case-insensitive):
  - `Word` (or `Lemma`, `Term`)
  - `Valence` (or `V`)
  - `Arousal` (or `A`)
  - `Dominance` (or `D`)

Notes:
- Values should be in [0,1]. If your lexicon uses 1..9 scales (e.g., Warriner norms), the generator will linearly normalize to [0,1].
- Recommended source: NRC VAD Lexicon (requires license/terms acceptance):
  - https://saifmohammad.com/WebPages/nrc-vad.html
- File naming is free, but files including keywords like `vad`, `nrc`, or `lexicon` will be preferred when auto-discovering.

Example usage:
```bash
# Minimal: auto-discover a lexicon placed in this directory and write to the model folder
python app/vad_maps/gen_vad_map.py --out-model models/emotion/Chinese-Emotion-Small --fallback app/vad_maps/default.json

# Explicit lexicon
python app/vad_maps/gen_vad_map.py \
  --lexicon app/vad_maps/lexicons/NRC-VAD-Lexicon.txt \
  --synonyms app/vad_maps/synonyms.json \
  --out models/emotion/Chinese-Emotion-Small/vad_map.json
```
