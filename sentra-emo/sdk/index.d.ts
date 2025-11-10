export interface SentraEmoOptions {
  baseURL?: string;
  timeout?: number;
}

export interface LabelScore {
  label: string;
  score: number;
}

export interface SentimentResult {
  label: string;
  scores: Record<string, number>;
  raw_model?: string | null;
}

export interface VADResult {
  valence: number;
  arousal: number;
  dominance: number;
  method?: string;
}

export interface PADResult {
  pleasure: number;
  arousal: number;
  dominance: number;
}

export interface StressResult {
  score: number;
  level: string;
}

export interface MBTIDimension {
  axis: string;
  letter: string;
  score: number;
  metric: string;
  value: number;
  low: number;
  high: number;
}

export interface MBTIResult {
  type: string;
  dimensions: MBTIDimension[];
  method: string;
  confidence: number;
  dominant_emotion?: string | null;
  traits_en?: string[];
  explain_en?: string;
}

export interface AnalyzeResponse {
  sentiment: SentimentResult;
  emotions: LabelScore[];
  vad: VADResult;
  pad: PADResult;
  stress: StressResult;
  models: Record<string, string>;
}

export interface RequestOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export interface RangeOptions extends RequestOptions {
  start?: string | number | Date;
  end?: string | number | Date;
}

export interface UserEventsOptions extends RangeOptions {
  limit?: number;
}

export interface UserAnalyticsOptions extends RangeOptions {
  days?: number;
}

export interface UserStateModel {
  userid: string;
  username?: string | null;
  count: number;
  vad: VADResult;
  emotions: LabelScore[];
  stress: StressResult;
  updated_at: string;
}

export interface UserEventModel {
  ts: string;
  userid: string;
  username?: string | null;
  text: string;
  sentiment: string;
  valence: number;
  arousal: number;
  dominance: number;
  stress: number;
  top_emotions?: any;
}

export interface BatchOptions extends RequestOptions {
  concurrency?: number;
  onProgress?: (p: { index: number; total: number }) => void;
}

export default class SentraEmo {
  constructor(options?: SentraEmoOptions);
  baseURL: string;
  timeout: number;

  health(opts?: RequestOptions): Promise<any>;
  models(opts?: RequestOptions): Promise<any>;
  metrics(opts?: RequestOptions): Promise<any>;
  analyze(text: string | { text: string }, opts?: RequestOptions): Promise<AnalyzeResponse>;
  analyzeBatch(texts: string[], opts?: BatchOptions): Promise<(AnalyzeResponse | { error: string })[]>;
  batchAnalyze(texts: string[], opts?: BatchOptions): Promise<(AnalyzeResponse | { error: string })[]>;
  userState(userid: string, opts?: RequestOptions): Promise<UserStateModel>;
  userEvents(userid: string, opts?: UserEventsOptions): Promise<UserEventModel[]>;
  userAnalytics(userid: string, opts?: UserAnalyticsOptions): Promise<{
    total_events: number;
    avg_valence: number;
    avg_arousal: number;
    avg_dominance: number;
    avg_stress: number;
    first_event?: string | null;
    last_event?: string | null;
    v_std?: number;
    a_std?: number;
    d_std?: number;
    pos_ratio?: number;
    neg_ratio?: number;
    top_emotions?: LabelScore[];
    mbti?: MBTIResult;
    thresholds?: {
      IE_A: { low: number; high: number };
      SN_VSTD: { low: number; high: number };
      TF_POS: { low: number; high: number };
      JP_ASTD: { low: number; high: number };
      POS_V_CUT: number;
      NEG_V_CUT: number;
    };
  }>;
  userExport(userid: string, opts?: RequestOptions): Promise<{ status: string; path: string; format: string }>;
}
