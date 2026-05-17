use serde::{Deserialize, Serialize};

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Tick {
    pub deck_id: u32,
    pub global_frame: u64,
    pub source_frame: f64,
    pub position_seconds: f64,
    pub deck_beat: f64,
    pub deck_bar: f64,
    pub global_master_beat: f64,
    pub global_master_bar: f64,
    pub global_master_bpm: f64,
    pub loop_start_beat: f64,
    pub loop_length_beats: f64,
    pub volume: f32,
    pub ratio: f64,
    pub effective_bpm: f64,
    pub playing: u8,
    pub synced: u8,
    pub loop_active: u8,
    pub phase_diff_samples: i64,
}
