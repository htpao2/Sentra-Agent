from pydantic import BaseModel, Field
from typing import List, Dict, Optional


class AnalyzeRequest(BaseModel):
    text: str = Field(..., description="需要分析的文本")
    userid: Optional[str] = None
    username: Optional[str] = None

class BatchAnalyzeRequest(BaseModel):
    texts: List[str] = Field(..., description="需要批量分析的文本列表，至少包含一条")
    userid: Optional[str] = None
    username: Optional[str] = None


class LabelScore(BaseModel):
    label: str
    score: float


class SentimentResult(BaseModel):
    label: str
    scores: Dict[str, float]
    raw_model: Optional[str] = None


class VADResult(BaseModel):
    valence: float
    arousal: float
    dominance: float
    method: str = "emotion_mapping"


class PADResult(BaseModel):
    pleasure: float
    arousal: float
    dominance: float


class StressResult(BaseModel):
    score: float
    level: str


class UserState(BaseModel):
    userid: str
    username: Optional[str] = None
    count: int
    vad: VADResult
    emotions: List[LabelScore]
    stress: StressResult
    updated_at: str


class AnalyzeResponse(BaseModel):
    sentiment: SentimentResult
    emotions: List[LabelScore]
    vad: VADResult
    pad: PADResult
    stress: StressResult
    models: Dict[str, str]
    user: Optional[UserState] = None
