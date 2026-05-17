use std::path::PathBuf;

use djengine::analysis::{decode_file, detect_bpm, extract_beats, extract_peaks};
use djengine::audio::{Command, DecodedTrack, Engine, EngineConfig};
use djengine::core::BeatGrid;

const DEVICE_SAMPLE_RATE: u32 = 48_000;
const OUTPUT_CHANNELS: usize = 2;

fn fixture_path(name: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../jensdjold/test-assets")
        .join(name);
    assert!(path.exists(), "missing MP3 fixture at {}", path.display());
    path
}

fn to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32)
        .collect()
}

fn analyzed_track(name: &str, expected_bpm: f32) -> DecodedTrack {
    let audio = decode_file(fixture_path(name)).expect("fixture should decode");
    let mono = to_mono(&audio.samples, audio.channels);
    let analysis = extract_beats(&mono, audio.sample_rate);

    assert!(
        (analysis.bpm - expected_bpm).abs() <= 0.75,
        "{name}: expected about {expected_bpm} BPM, got {}",
        analysis.bpm
    );
    assert!(
        analysis.beats.len() >= 8,
        "{name}: expected at least 8 detected beats, got {}",
        analysis.beats.len()
    );

    let grid = BeatGrid::new(analysis.beats);
    let grid_bpm = 60.0
        / grid
            .beat_duration()
            .expect("fixture grid has beat duration");
    assert!(
        (grid_bpm - f64::from(expected_bpm)).abs() <= 0.75,
        "{name}: expected grid near {expected_bpm} BPM, got {grid_bpm}"
    );

    DecodedTrack::new(
        audio.sample_rate,
        audio.channels,
        audio.samples,
        Some(grid),
        Some(grid_bpm),
    )
}

fn process_seconds(engine: &mut Engine, seconds: f64) {
    let frames = (seconds * f64::from(DEVICE_SAMPLE_RATE)).round() as usize;
    let mut output = vec![0.0; 1024 * OUTPUT_CHANNELS];
    let mut remaining = frames;
    while remaining > 0 {
        let block = remaining.min(1024);
        engine.process_offline(block, &mut output[..block * OUTPUT_CHANNELS]);
        remaining -= block;
    }
}

fn new_engine() -> Engine {
    Engine::new(EngineConfig {
        device_sample_rate: DEVICE_SAMPLE_RATE,
        output_channels: OUTPUT_CHANNELS,
        max_decks: 16,
        telemetry_hz: 60,
    })
}

#[test]
fn beat_mp3_fixtures_decode_analyze_and_extract_peaks() {
    for (name, expected_bpm) in [
        ("beat100.mp3", 100.0),
        ("beat120.mp3", 120.0),
        ("beat125.mp3", 125.0),
    ] {
        let path = fixture_path(name);
        let audio = decode_file(&path).expect("fixture should decode");
        assert_eq!(audio.sample_rate, 44_100);
        assert_eq!(audio.channels, 2);
        assert!(audio.frames > 44_100);

        let bpm = detect_bpm(&path).expect("fixture BPM should be detectable");
        assert!(
            (bpm - expected_bpm).abs() <= 0.75,
            "{name}: expected about {expected_bpm} BPM, got {bpm}"
        );

        let peaks = extract_peaks(&audio.samples, audio.channels, 64);
        assert_eq!(peaks.len(), 64);
        assert!(
            peaks.iter().any(|peak| peak.max > 0.1),
            "{name}: expected visible waveform peaks"
        );
    }
}

#[test]
fn real_mp3_decks_sync_to_global_master_across_different_bpms() {
    let mut engine = new_engine();
    engine
        .load_track_at(0, analyzed_track("beat120.mp3", 120.0))
        .unwrap();
    engine
        .load_track_at(1, analyzed_track("beat100.mp3", 100.0))
        .unwrap();

    let global_bpm = engine.deck(0).unwrap().original_bpm();
    engine
        .handle_command(Command::SetMasterBpm {
            bpm: Some(global_bpm),
        })
        .unwrap();
    engine.handle_command(Command::Play { deck_id: 0 }).unwrap();
    engine.handle_command(Command::Play { deck_id: 1 }).unwrap();
    engine
        .handle_command(Command::EngageSync { deck_id: 0 })
        .unwrap();
    engine
        .handle_command(Command::EngageSync { deck_id: 1 })
        .unwrap();

    process_seconds(&mut engine, 2.0);
    let first_master_diff = engine
        .phase_difference_samples(0, engine.current_global_frame())
        .unwrap();
    let first_diff = engine
        .phase_difference_samples(1, engine.current_global_frame())
        .unwrap();
    process_seconds(&mut engine, 2.0);
    let second_master_diff = engine
        .phase_difference_samples(0, engine.current_global_frame())
        .unwrap();
    let second_diff = engine
        .phase_difference_samples(1, engine.current_global_frame())
        .unwrap();

    assert!(
        first_master_diff.abs() <= 12 && second_master_diff.abs() <= 12,
        "real MP3 global master source offset too large: first {first_master_diff}, second {second_master_diff}"
    );
    assert!(
        first_diff.abs() <= 12 && second_diff.abs() <= 12,
        "real MP3 global sync offset too large: first {first_diff}, second {second_diff}"
    );
    assert!(
        (second_diff - first_diff).abs() <= 1,
        "real MP3 global sync drifted from {first_diff} to {second_diff} samples"
    );

    let master = engine.deck(0).unwrap();
    assert!((master.ratio() - 1.0).abs() < 0.002);
    assert!(master.synced_to_master);
    let follower = engine.deck(1).unwrap();
    assert!((follower.ratio() - 1.2).abs() < 0.002);
    assert!(follower.synced_to_master);
}

#[test]
fn real_mp3_raw_loop_keeps_playhead_inside_loop() {
    let mut engine = new_engine();
    let track = analyzed_track("beat120.mp3", 120.0);
    let grid = track.beat_grid.clone().unwrap();
    let loop_start = f64::from(grid.beats[2]);
    let loop_end = f64::from(grid.beats[6]);

    engine.load_track_at(0, track).unwrap();
    engine
        .handle_command(Command::RawSetLoopSeconds {
            deck_id: 0,
            start_seconds: loop_start,
            end_seconds: loop_end,
            active: true,
        })
        .unwrap();
    engine.handle_command(Command::Play { deck_id: 0 }).unwrap();

    process_seconds(
        &mut engine,
        (loop_end - loop_start) * 3.0 + loop_start + 0.25,
    );

    let deck = engine.deck(0).unwrap();
    let loop_state = deck.loop_state;
    let position_seconds =
        deck.source_frame_at(engine.current_global_frame()) / f64::from(deck.track.sample_rate);

    assert!(loop_state.active);
    assert!((loop_state.start_seconds - loop_start).abs() < 1.0e-6);
    assert!((loop_state.end_seconds - loop_end).abs() < 1.0e-6);
    assert!(
        position_seconds >= loop_start && position_seconds < loop_end,
        "playhead escaped raw loop: {position_seconds} not in [{loop_start}, {loop_end})"
    );
}

#[test]
fn real_mp3_beat_loop_snaps_to_grid_and_wraps() {
    let mut engine = new_engine();
    let track = analyzed_track("beat125.mp3", 125.0);
    let grid = track.beat_grid.clone().unwrap();
    let seek_beat = 3.08;

    engine.load_track_at(0, track).unwrap();
    engine
        .handle_command(Command::SeekBeat {
            deck_id: 0,
            beat: seek_beat,
        })
        .unwrap();
    engine
        .handle_command(Command::SetLoopBeats {
            deck_id: 0,
            start_beat: None,
            length_beats: 4.0,
        })
        .unwrap();
    engine.handle_command(Command::Play { deck_id: 0 }).unwrap();

    let deck = engine.deck(0).unwrap();
    let loop_start = deck.loop_state.start_seconds;
    let loop_end = deck.loop_state.end_seconds;
    assert!(deck.loop_state.active);
    assert!((loop_start - f64::from(grid.beats[3])).abs() < 0.02);
    assert!((loop_end - grid.time_at_beat(7.0).unwrap()).abs() < 0.02);

    process_seconds(&mut engine, (loop_end - loop_start) * 2.5);

    let deck = engine.deck(0).unwrap();
    let position_seconds =
        deck.source_frame_at(engine.current_global_frame()) / f64::from(deck.track.sample_rate);
    assert!(
        position_seconds >= loop_start && position_seconds < loop_end,
        "playhead escaped beat loop: {position_seconds} not in [{loop_start}, {loop_end})"
    );

    engine
        .handle_command(Command::ClearLoop { deck_id: 0 })
        .unwrap();
    assert!(!engine.deck(0).unwrap().loop_state.active);
}
