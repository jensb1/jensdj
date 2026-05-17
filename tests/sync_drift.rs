use std::sync::Arc;

use djengine::audio::{Command, DecodedTrack, Engine, EngineConfig};
use djengine::core::BeatGrid;

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: usize = 2;

fn click_track(bpm: f64, minutes: f64) -> DecodedTrack {
    let seconds = minutes * 60.0;
    let frames = (seconds * f64::from(SAMPLE_RATE)) as usize;
    let mut samples = vec![0.0; frames * CHANNELS];
    let beat_duration = 60.0 / bpm;
    let mut beats = Vec::new();
    let mut beat = 0_u64;
    loop {
        let t = beat as f64 * beat_duration;
        if t >= seconds {
            break;
        }
        beats.push(t as f32);
        let frame = (t * f64::from(SAMPLE_RATE)).round() as usize;
        if frame < frames {
            for offset in 0..16 {
                let gain = 1.0 - offset as f32 / 16.0;
                if frame + offset < frames {
                    samples[(frame + offset) * CHANNELS] = gain;
                    samples[(frame + offset) * CHANNELS + 1] = gain;
                }
            }
        }
        beat += 1;
    }
    DecodedTrack {
        sample_rate: SAMPLE_RATE,
        channels: CHANNELS,
        samples: Arc::new(samples),
        beat_grid: Some(BeatGrid::new(beats)),
        original_bpm: Some(bpm),
    }
}

fn setup_synced_engine() -> Engine {
    let mut engine = Engine::new(EngineConfig {
        device_sample_rate: SAMPLE_RATE,
        output_channels: CHANNELS,
        max_decks: 16,
        telemetry_hz: 60,
    });
    engine.load_track_at(0, click_track(120.0, 10.2)).unwrap();
    engine.load_track_at(1, click_track(100.0, 10.2)).unwrap();
    engine
        .handle_command(Command::SetMasterBpm { bpm: Some(120.0) })
        .unwrap();
    engine.handle_command(Command::Play { deck_id: 0 }).unwrap();
    engine.handle_command(Command::Play { deck_id: 1 }).unwrap();
    engine
        .handle_command(Command::EngageSync { deck_id: 0 })
        .unwrap();
    engine
        .handle_command(Command::EngageSync { deck_id: 1 })
        .unwrap();
    engine
}

fn process(engine: &mut Engine, frames: usize) {
    // These tests exercise beat-clock drift. Rendered sync has separate waveform tests.
    let deck_0_playing = engine.deck(0).map(|deck| deck.playing);
    let deck_1_playing = engine.deck(1).map(|deck| deck.playing);
    if let Some(deck) = engine.deck_mut(0) {
        deck.playing = false;
    }
    if let Some(deck) = engine.deck_mut(1) {
        deck.playing = false;
    }

    let mut buffer = vec![0.0; 4096 * CHANNELS];
    let mut remaining = frames;
    while remaining > 0 {
        let block = remaining.min(4096);
        engine.process_offline(block, &mut buffer[..block * CHANNELS]);
        remaining -= block;
    }

    if let (Some(deck), Some(playing)) = (engine.deck_mut(0), deck_0_playing) {
        deck.playing = playing;
    }
    if let (Some(deck), Some(playing)) = (engine.deck_mut(1), deck_1_playing) {
        deck.playing = playing;
    }
}

fn assert_phase_locked(engine: &Engine, follower: usize) {
    let global = engine.current_global_frame();
    let diff = engine.phase_difference_samples(follower, global).unwrap();
    assert!(
        diff.abs() <= 1,
        "phase drift at global frame {global}: {diff} samples"
    );
}

#[test]
fn follower_stays_within_one_sample_for_ten_minutes() {
    let mut engine = setup_synced_engine();
    process(&mut engine, SAMPLE_RATE as usize * 60 * 10);
    assert_phase_locked(&engine, 0);
    assert_phase_locked(&engine, 1);
}

#[test]
fn changing_global_master_bpm_preserves_phase() {
    let mut engine = setup_synced_engine();
    process(&mut engine, SAMPLE_RATE as usize * 90);
    engine
        .handle_command(Command::SetMasterBpm { bpm: Some(110.0) })
        .unwrap();
    process(&mut engine, SAMPLE_RATE as usize * 60);
    assert_phase_locked(&engine, 0);
    assert_phase_locked(&engine, 1);
}

#[test]
fn stop_and_restart_preserves_phase_after_resync() {
    let mut engine = setup_synced_engine();
    process(&mut engine, SAMPLE_RATE as usize * 30);
    engine.handle_command(Command::Stop { deck_id: 1 }).unwrap();
    process(&mut engine, SAMPLE_RATE as usize);
    engine.handle_command(Command::Play { deck_id: 1 }).unwrap();
    engine
        .handle_command(Command::EngageSync { deck_id: 1 })
        .unwrap();
    process(&mut engine, SAMPLE_RATE as usize * 60);
    assert_phase_locked(&engine, 1);
}

#[test]
fn synced_jump_beats_cannot_create_fractional_phase_offset() {
    let mut engine = setup_synced_engine();
    process(&mut engine, SAMPLE_RATE as usize * 4);
    engine
        .handle_command(Command::JumpBeats {
            deck_id: 1,
            beats: 4.0,
        })
        .unwrap();
    assert_phase_locked(&engine, 1);

    assert!(
        engine
            .handle_command(Command::JumpBeats {
                deck_id: 1,
                beats: 0.5,
            })
            .is_err(),
        "fractional jumps on synced decks must be rejected"
    );
    assert_phase_locked(&engine, 1);
}
