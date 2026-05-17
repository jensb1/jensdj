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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandAction {
    Play,
    Pause,
    Stop,
    SeekBeat,
    JumpBeats,
    SetVolume,
    SetTempo,
    SetMaster,
    SetLoopBeats,
    ClearLoop,
    SetMasterBpm,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    DeckLoaded {
        deck_id: u32,
        global_frame: u64,
    },
    DeckUnloaded {
        deck_id: u32,
        global_frame: u64,
    },
    TransportStarted {
        deck_id: u32,
        global_frame: u64,
    },
    TransportPaused {
        deck_id: u32,
        global_frame: u64,
    },
    TransportStopped {
        deck_id: u32,
        global_frame: u64,
    },
    LoopChanged {
        deck_id: u32,
        global_frame: u64,
        start_beat: f64,
        length_beats: f64,
    },
    LoopCleared {
        deck_id: u32,
        global_frame: u64,
    },
    SyncChanged {
        deck_id: u32,
        global_frame: u64,
        synced: bool,
    },
    MasterBpmChanged {
        global_frame: u64,
        bpm: f64,
    },
    ScheduledArmed {
        schedule_id: u64,
        action: CommandAction,
        target_global_frame: u64,
        target_global_master_beat: f64,
    },
    ScheduledFired {
        schedule_id: u64,
        action: CommandAction,
        global_frame: u64,
        global_master_beat: f64,
    },
    ClockTick {
        subscription_id: u64,
        global_frame: u64,
        time_seconds: f64,
        global_master_beat: f64,
        global_master_bar: f64,
        tick_index: u64,
    },
}
