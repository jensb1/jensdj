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

fn discontinuous_loop_track() -> DecodedTrack {
    let sample_rate = 48_000;
    let frames = sample_rate as usize / 2;
    let channels = 2;
    let mut samples = vec![0.0; frames * channels];
    for frame in 0..frames {
        let value = if frame < 512 { -0.8 } else { 0.8 };
        for channel in 0..channels {
            samples[frame * channels + channel] = value;
        }
    }

    DecodedTrack {
        sample_rate,
        channels,
        samples: Arc::new(samples),
        beat_grid: Some(BeatGrid::new(vec![0.0, 0.5])),
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

#[test]
fn raw_loop_wrap_is_crossfaded() {
    let mut engine = Engine::new(EngineConfig {
        device_sample_rate: 48_000,
        output_channels: 2,
        max_decks: 4,
        telemetry_hz: 60,
    });
    engine.load_track_at(0, discontinuous_loop_track()).unwrap();
    engine
        .handle_command(Command::RawSetLoopSeconds {
            deck_id: 0,
            start_seconds: 0.0,
            end_seconds: 0.25,
            active: true,
        })
        .unwrap();
    engine.handle_command(Command::Play { deck_id: 0 }).unwrap();

    let frames = 48_000 / 4 + 16;
    let mut out = vec![0.0; frames * 2];
    engine.process_offline(frames, &mut out);

    let before_wrap = out[(48_000 / 4 - 1) * 2];
    let after_wrap = out[(48_000 / 4) * 2];
    assert!(
        (after_wrap - before_wrap).abs() < 0.05,
        "loop wrap jumped from {before_wrap} to {after_wrap}"
    );
}
