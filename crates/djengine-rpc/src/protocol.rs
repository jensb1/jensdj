use serde::{Deserialize, Serialize};
use serde_json::Value;

use djengine_audio::{DeckId, QuantizeMode};

#[derive(Debug, Clone, Deserialize)]
pub struct RpcRequest {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcNotification {
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoadParams {
    pub deck_id: Option<DeckId>,
    pub path: String,
    #[serde(default)]
    pub analyze: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeckParams {
    pub deck_id: DeckId,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SeekBeatParams {
    pub deck_id: DeckId,
    pub beat: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JumpBeatsParams {
    pub deck_id: DeckId,
    pub beats: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawSeekSecondsParams {
    pub deck_id: DeckId,
    pub seconds: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetVolumeParams {
    pub deck_id: DeckId,
    pub volume: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetTempoParams {
    pub deck_id: DeckId,
    pub ratio: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetOriginalBpmParams {
    pub deck_id: DeckId,
    pub bpm: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetMasterBpmParams {
    pub bpm: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawSetLoopSecondsParams {
    pub deck_id: DeckId,
    pub start_seconds: f64,
    pub end_seconds: f64,
    #[serde(default = "default_true")]
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetLoopBeatsParams {
    pub deck_id: DeckId,
    pub start_beat: Option<f64>,
    #[serde(alias = "beats")]
    pub length_beats: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScheduleParams {
    pub action: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub quantize: QuantizeMode,
    #[serde(default)]
    pub offset_beats: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubscribeParams {
    #[serde(default)]
    pub events: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubscribeClockParams {
    pub interval_beats: Option<f64>,
    pub subdivisions_per_beat: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UnsubscribeClockParams {
    pub subscription_id: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AnalyzeParams {
    pub path: String,
    #[serde(default = "default_peak_points")]
    pub peak_points: usize,
    #[serde(default)]
    pub waveform_levels: Vec<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoadResult {
    pub deck_id: DeckId,
    pub sample_rate: u32,
    pub channels: usize,
    pub frames: usize,
    pub bpm: Option<f32>,
    pub beats: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalysisResult {
    pub sample_rate: u32,
    pub channels: usize,
    pub frames: usize,
    pub duration_seconds: f64,
    pub bpm: f32,
    pub beats: Vec<f32>,
    pub peaks: Vec<djengine_analysis::Peak>,
    pub waveform_levels: Vec<WaveformLevel>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WaveformLevel {
    pub points: usize,
    pub peaks: Vec<djengine_analysis::Peak>,
}

impl RpcResponse {
    pub fn ok(id: Option<Value>, result: impl Serialize) -> Self {
        Self {
            id,
            result: Some(serde_json::to_value(result).unwrap_or(Value::Null)),
            error: None,
        }
    }

    pub fn empty(id: Option<Value>) -> Self {
        Self {
            id,
            result: Some(Value::Bool(true)),
            error: None,
        }
    }

    pub fn err(id: Option<Value>, code: i32, message: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_peak_points() -> usize {
    1024
}
