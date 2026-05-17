use std::sync::Arc;

use djengine::audio::{Command, DecodedTrack, Engine, EngineConfig};
use djengine::core::BeatGrid;

fn constant_track() -> DecodedTrack {
    let sample_rate = 48_000;
    let frames = sample_rate as usize;
    DecodedTrack {
        sample_rate,
        channels: 2,
        samples: Arc::new(vec![0.25; frames * 2]),
        beat_grid: Some(BeatGrid::new(vec![0.0, 0.5, 1.0])),
        original_bpm: Some(120.0),
    }
}

#[test]
fn play_pause_seek_and_volume_work_offline() {
    let mut engine = Engine::new(EngineConfig::default());
    engine.load_track_at(0, constant_track()).unwrap();
    engine
        .handle_command(Command::SetVolume {
            deck_id: 0,
            volume: 0.5,
        })
        .unwrap();
    engine.handle_command(Command::Play { deck_id: 0 }).unwrap();
    let mut out = vec![0.0; 128 * 2];
    engine.process_offline(128, &mut out);
    assert!(out.iter().any(|sample| (*sample - 0.125).abs() < 1.0e-6));

    engine
        .handle_command(Command::Pause { deck_id: 0 })
        .unwrap();
    out.fill(1.0);
    engine.process_offline(128, &mut out);
    assert!(out.iter().all(|sample| *sample == 0.0));

    engine
        .handle_command(Command::RawSeekSeconds {
            deck_id: 0,
            seconds: 0.25,
        })
        .unwrap();
    let pos = engine.deck_position(0).unwrap();
    assert!((pos.source_frame_at_start - 12_000.0).abs() < 1.0);
}
