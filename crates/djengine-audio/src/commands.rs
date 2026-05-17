use serde::{Deserialize, Serialize};

use crate::deck::DecodedTrack;

pub type DeckId = usize;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantizeMode {
    #[default]
    Beat,
    Bar,
}

#[derive(Debug, Clone)]
pub enum Command {
    Load {
        deck_id: DeckId,
        track: DecodedTrack,
    },
    Unload {
        deck_id: DeckId,
    },
    Play {
        deck_id: DeckId,
    },
    Pause {
        deck_id: DeckId,
    },
    Stop {
        deck_id: DeckId,
    },
    SeekBeat {
        deck_id: DeckId,
        beat: f64,
    },
    JumpBeats {
        deck_id: DeckId,
        beats: f64,
    },
    RawSeekSeconds {
        deck_id: DeckId,
        seconds: f64,
    },
    SetVolume {
        deck_id: DeckId,
        volume: f32,
    },
    SetTempo {
        deck_id: DeckId,
        ratio: f64,
    },
    SetOriginalBpm {
        deck_id: DeckId,
        bpm: f64,
    },
    SetMaster {
        deck_id: DeckId,
    },
    EngageSync {
        deck_id: DeckId,
    },
    DisengageSync {
        deck_id: DeckId,
    },
    RawSetLoopSeconds {
        deck_id: DeckId,
        start_seconds: f64,
        end_seconds: f64,
        active: bool,
    },
    SetLoopBeats {
        deck_id: DeckId,
        start_beat: Option<f64>,
        length_beats: f64,
    },
    ClearLoop {
        deck_id: DeckId,
    },
    SetMasterBpm {
        bpm: Option<f64>,
    },
    Schedule {
        quantize: QuantizeMode,
        offset_beats: f64,
        command: Box<Command>,
    },
    SetClockSubscription {
        subscription_id: u64,
        interval_beats: f64,
    },
    ClearClockSubscription {
        subscription_id: u64,
    },
}
