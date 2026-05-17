use std::path::PathBuf;
use std::sync::Arc;

use djengine::analysis::{decode_file, extract_beats};
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
    assert!((analysis.bpm - expected_bpm).abs() <= 0.75);
    let grid = BeatGrid::new(analysis.beats);
    let grid_bpm = 60.0 / grid.beat_duration().unwrap();
    DecodedTrack::new(
        audio.sample_rate,
        audio.channels,
        audio.samples,
        Some(grid),
        Some(grid_bpm),
    )
}

fn click_track(bpm: f64, seconds: f64) -> DecodedTrack {
    let frames = (seconds * f64::from(DEVICE_SAMPLE_RATE)).round() as usize;
    let mut samples = vec![0.0; frames * OUTPUT_CHANNELS];
    let beat_duration = 60.0 / bpm;
    let mut beats = Vec::new();
    let mut beat = 0_u64;
    loop {
        let time = beat as f64 * beat_duration;
        if time >= seconds {
            break;
        }
        beats.push(time as f32);
        let frame = (time * f64::from(DEVICE_SAMPLE_RATE)).round() as usize;
        for offset in 0..128 {
            if frame + offset < frames {
                let gain = 1.0 - offset as f32 / 128.0;
                for ch in 0..OUTPUT_CHANNELS {
                    samples[(frame + offset) * OUTPUT_CHANNELS + ch] = gain;
                }
            }
        }
        beat += 1;
    }

    DecodedTrack {
        sample_rate: DEVICE_SAMPLE_RATE,
        channels: OUTPUT_CHANNELS,
        samples: Arc::new(samples),
        beat_grid: Some(BeatGrid::new(beats)),
        original_bpm: Some(bpm),
    }
}

fn render_synced_track(track: DecodedTrack, loop_beats: Option<f64>, seconds: f64) -> Vec<f32> {
    render_synced_track_at_bpm(track, 120.0, loop_beats, seconds)
}

fn render_synced_track_at_bpm(
    track: DecodedTrack,
    master_bpm: f64,
    loop_beats: Option<f64>,
    seconds: f64,
) -> Vec<f32> {
    let mut engine = Engine::new(EngineConfig {
        device_sample_rate: DEVICE_SAMPLE_RATE,
        output_channels: OUTPUT_CHANNELS,
        max_decks: 16,
        telemetry_hz: 60,
    });
    engine.load_track_at(0, track).unwrap();
    engine
        .handle_command(Command::SetMasterBpm {
            bpm: Some(master_bpm),
        })
        .unwrap();
    if let Some(length_beats) = loop_beats {
        engine
            .handle_command(Command::SetLoopBeats {
                deck_id: 0,
                start_beat: Some(0.0),
                length_beats,
            })
            .unwrap();
    }
    engine
        .handle_command(Command::EngageSync { deck_id: 0 })
        .unwrap();

    let frames = (seconds * f64::from(DEVICE_SAMPLE_RATE)).round() as usize;
    let mut stereo = vec![0.0; frames * OUTPUT_CHANNELS];
    let mut scratch = vec![0.0; 1024 * OUTPUT_CHANNELS];
    let mut rendered = 0;
    while rendered < frames {
        let block = (frames - rendered).min(1024);
        engine.process_offline(block, &mut scratch[..block * OUTPUT_CHANNELS]);
        stereo[rendered * OUTPUT_CHANNELS..(rendered + block) * OUTPUT_CHANNELS]
            .copy_from_slice(&scratch[..block * OUTPUT_CHANNELS]);
        rendered += block;
    }
    to_mono(&stereo, OUTPUT_CHANNELS)
}

fn render_synced_fixture(
    name: &str,
    expected_bpm: f32,
    loop_beats: Option<f64>,
    seconds: f64,
) -> Vec<f32> {
    render_synced_track(analyzed_track(name, expected_bpm), loop_beats, seconds)
}

fn render_into(engine: &mut Engine, frames: usize) -> Vec<f32> {
    let mut stereo = vec![0.0; frames * OUTPUT_CHANNELS];
    let mut scratch = vec![0.0; 1024 * OUTPUT_CHANNELS];
    let mut rendered = 0;
    while rendered < frames {
        let block = (frames - rendered).min(1024);
        engine.process_offline(block, &mut scratch[..block * OUTPUT_CHANNELS]);
        stereo[rendered * OUTPUT_CHANNELS..(rendered + block) * OUTPUT_CHANNELS]
            .copy_from_slice(&scratch[..block * OUTPUT_CHANNELS]);
        rendered += block;
    }
    to_mono(&stereo, OUTPUT_CHANNELS)
}

fn strongest_peak_near(samples: &[f32], center: usize, radius: usize) -> (usize, f32) {
    let start = center.saturating_sub(radius);
    let end = center.saturating_add(radius).min(samples.len());
    let index = (start..end)
        .max_by(|&a, &b| samples[a].abs().total_cmp(&samples[b].abs()))
        .unwrap_or(center);
    (index, samples[index].abs())
}

fn transient_flux(samples: &[f32], window: usize) -> Vec<f32> {
    let window = window.max(1);
    let mut prefix = Vec::with_capacity(samples.len() + 1);
    prefix.push(0.0f32);
    for &sample in samples {
        prefix.push(prefix.last().copied().unwrap_or(0.0) + sample * sample);
    }

    let mut flux = vec![0.0; samples.len()];
    for index in window * 2..samples.len() {
        let current = prefix[index + 1] - prefix[index + 1 - window];
        let previous = prefix[index + 1 - window] - prefix[index + 1 - window * 2];
        flux[index] = (current - previous).max(0.0);
    }
    flux
}

fn strongest_transient_near(flux: &[f32], center: usize, radius: usize) -> (usize, f32) {
    let start = center.saturating_sub(radius);
    let end = center.saturating_add(radius).min(flux.len());
    let index = (start..end)
        .max_by(|&a, &b| flux[a].total_cmp(&flux[b]))
        .unwrap_or(center);
    (index, flux[index])
}

fn assert_rendered_transients_aligned(
    label: &str,
    rendered: &[(&str, Vec<f32>)],
    master_bpm: f64,
    beats: usize,
    tolerance_samples: isize,
) {
    let fluxes = rendered
        .iter()
        .map(|(name, samples)| (*name, transient_flux(samples, 96)))
        .collect::<Vec<_>>();
    let beat_frames = (f64::from(DEVICE_SAMPLE_RATE) * 60.0 / master_bpm).round() as usize;
    let search_radius = (f64::from(DEVICE_SAMPLE_RATE) * 0.08).round() as usize;
    let mut max_peak_spread = 0isize;
    let mut max_flux_spread = 0isize;
    let mut checked = 0usize;

    for beat in 1..=beats {
        let center = (4 + beat) * beat_frames;
        if rendered
            .iter()
            .any(|(_, samples)| center + search_radius >= samples.len())
        {
            break;
        }

        let mut peak_positions = Vec::with_capacity(rendered.len());
        for (name, samples) in rendered {
            let (peak, level) = strongest_peak_near(samples, center, search_radius);
            assert!(
                level > 0.1,
                "{label}: {name} beat {beat} missing transient peak {level}"
            );
            peak_positions.push((*name, peak as isize));
        }

        let mut flux_positions = Vec::with_capacity(fluxes.len());
        for (name, flux) in &fluxes {
            let (peak, _strength) = strongest_transient_near(flux, center, search_radius);
            flux_positions.push((*name, peak as isize));
        }

        let min_peak = peak_positions
            .iter()
            .map(|(_, peak)| *peak)
            .min()
            .unwrap_or(0);
        let max_peak = peak_positions
            .iter()
            .map(|(_, peak)| *peak)
            .max()
            .unwrap_or(0);
        let peak_spread = max_peak - min_peak;
        max_peak_spread = max_peak_spread.max(peak_spread);

        let min_flux = flux_positions
            .iter()
            .map(|(_, peak)| *peak)
            .min()
            .unwrap_or(0);
        let max_flux = flux_positions
            .iter()
            .map(|(_, peak)| *peak)
            .max()
            .unwrap_or(0);
        let flux_spread = max_flux - min_flux;
        max_flux_spread = max_flux_spread.max(flux_spread);
        checked += 1;

        assert!(
            peak_spread <= tolerance_samples,
            "{label}: beat {beat} peak-transient spread {peak_spread} samples across {peak_positions:?}; onset-flux positions {flux_positions:?}"
        );
    }

    assert!(
        checked >= beats / 2,
        "{label}: checked only {checked} beats"
    );
    eprintln!(
        "{label}: checked {checked} beats, max peak spread {max_peak_spread} samples, max onset-flux spread {max_flux_spread} samples"
    );
}

fn max_abs_and_step(samples: &[f32]) -> (f32, f32, usize) {
    let mut max_abs = 0.0f32;
    let mut max_step = 0.0f32;
    let mut max_step_index = 0usize;

    for (index, &sample) in samples.iter().enumerate() {
        max_abs = max_abs.max(sample.abs());
        if index > 0 {
            let step = (sample - samples[index - 1]).abs();
            if step > max_step {
                max_step = step;
                max_step_index = index;
            }
        }
    }

    (max_abs, max_step, max_step_index)
}

#[test]
fn transient_analyzer_validates_synced_mp3_loops_across_bpms() {
    for master_bpm in [80.0, 100.0, 120.0, 130.0] {
        let rendered = [
            ("beat100.mp3", 100.0),
            ("beat120.mp3", 120.0),
            ("beat125.mp3", 125.0),
        ]
        .into_iter()
        .map(|(name, source_bpm)| {
            (
                name,
                render_synced_track_at_bpm(
                    analyzed_track(name, source_bpm),
                    master_bpm,
                    Some(8.0),
                    24.0,
                ),
            )
        })
        .collect::<Vec<_>>();
        assert_rendered_transients_aligned(
            &format!("mp3 fixtures @ {master_bpm} BPM"),
            &rendered,
            master_bpm,
            24,
            48,
        );
    }
}

#[test]
fn synced_master_bpm_change_does_not_spike_rendered_audio() {
    let mut engine = Engine::new(EngineConfig {
        device_sample_rate: DEVICE_SAMPLE_RATE,
        output_channels: OUTPUT_CHANNELS,
        max_decks: 16,
        telemetry_hz: 60,
    });
    engine
        .load_track_at(0, analyzed_track("beat100.mp3", 100.0))
        .unwrap();
    engine
        .handle_command(Command::SetVolume {
            deck_id: 0,
            volume: 0.45,
        })
        .unwrap();
    engine
        .handle_command(Command::SetMasterBpm { bpm: Some(100.0) })
        .unwrap();
    engine
        .handle_command(Command::SetLoopBeats {
            deck_id: 0,
            start_beat: Some(0.0),
            length_beats: 8.0,
        })
        .unwrap();
    engine
        .handle_command(Command::EngageSync { deck_id: 0 })
        .unwrap();

    let before_frames = (2.0 * f64::from(DEVICE_SAMPLE_RATE)).round() as usize;
    let after_frames = (2.0 * f64::from(DEVICE_SAMPLE_RATE)).round() as usize;
    let mut rendered = render_into(&mut engine, before_frames);
    engine
        .handle_command(Command::SetMasterBpm { bpm: Some(90.0) })
        .unwrap();
    rendered.extend(render_into(&mut engine, after_frames));

    let transition = before_frames;
    let start = transition.saturating_sub(4096);
    let end = transition.saturating_add(4096).min(rendered.len());
    let max_abs = rendered[start..end]
        .iter()
        .copied()
        .map(f32::abs)
        .fold(0.0, f32::max);
    let max_step = rendered[start..end]
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).abs())
        .fold(0.0, f32::max);

    assert!(max_abs.is_finite() && max_abs < 0.8, "max abs {max_abs}");
    assert!(
        max_step.is_finite() && max_step < 0.8,
        "max adjacent step {max_step}"
    );
}

#[test]
fn rendered_130_bpm_mp3_loop_does_not_spike() {
    let rendered =
        render_synced_track_at_bpm(analyzed_track("beat100.mp3", 100.0), 130.0, Some(8.0), 28.0);
    let (max_abs, max_step, max_step_index) = max_abs_and_step(&rendered);

    assert!(max_abs.is_finite() && max_abs < 1.0, "max abs {max_abs}");
    assert!(
        max_step.is_finite() && max_step < 0.8,
        "max adjacent step {max_step} at sample {max_step_index}"
    );
}

#[test]
fn rendered_synced_mp3_transients_align() {
    let master = render_synced_fixture("beat120.mp3", 120.0, None, 4.0);
    let follower = render_synced_fixture("beat100.mp3", 100.0, None, 4.0);
    let beat_frames = (f64::from(DEVICE_SAMPLE_RATE) * 0.5).round() as usize;
    let search_radius = (f64::from(DEVICE_SAMPLE_RATE) * 0.08).round() as usize;

    for beat in 1..4 {
        let center = (4 + beat) * beat_frames;
        let (master_peak, master_level) = strongest_peak_near(&master, center, search_radius);
        let (follower_peak, follower_level) = strongest_peak_near(&follower, center, search_radius);
        assert!(
            master_level > 0.1 && follower_level > 0.1,
            "beat {beat}: missing rendered transient, master {master_level}, follower {follower_level}"
        );
        let diff = follower_peak as isize - master_peak as isize;
        assert!(
            diff.abs() <= 12,
            "beat {beat}: rendered transient offset {diff} samples"
        );
    }
}

#[test]
fn rendered_synced_mp3_loop_transients_align() {
    let master = render_synced_fixture("beat120.mp3", 120.0, Some(8.0), 12.0);
    let follower = render_synced_fixture("beat100.mp3", 100.0, Some(8.0), 12.0);
    let beat_frames = (f64::from(DEVICE_SAMPLE_RATE) * 0.5).round() as usize;
    let search_radius = (f64::from(DEVICE_SAMPLE_RATE) * 0.08).round() as usize;

    for beat in 1..20 {
        let center = (4 + beat) * beat_frames;
        let (master_peak, master_level) = strongest_peak_near(&master, center, search_radius);
        let (follower_peak, follower_level) = strongest_peak_near(&follower, center, search_radius);
        assert!(
            master_level > 0.1 && follower_level > 0.1,
            "beat {beat}: missing rendered loop transient, master {master_level}, follower {follower_level}"
        );
        let diff = follower_peak as isize - master_peak as isize;
        assert!(
            diff.abs() <= 12,
            "beat {beat}: rendered loop transient offset {diff} samples"
        );
    }
}

#[test]
fn rendered_80_bpm_loop_transients_stay_on_master_grid() {
    let rendered = render_synced_track_at_bpm(click_track(100.0, 28.0), 80.0, Some(8.0), 28.0);
    let beat_frames = (f64::from(DEVICE_SAMPLE_RATE) * 60.0 / 80.0).round() as usize;
    let search_radius = (f64::from(DEVICE_SAMPLE_RATE) * 0.08).round() as usize;

    for beat in 1..32 {
        let center = (4 + beat) * beat_frames;
        let (peak, level) = strongest_peak_near(&rendered, center, search_radius);
        assert!(
            level > 0.1,
            "beat {beat}: missing rendered transient {level}"
        );
        let diff = peak as isize - center as isize;
        assert!(
            diff.abs() <= 12,
            "beat {beat}: rendered transient offset {diff} samples"
        );
    }
}

#[test]
fn rendered_synced_click_transients_align_exactly() {
    let master = render_synced_track(click_track(120.0, 12.0), Some(8.0), 12.0);
    let follower = render_synced_track(click_track(100.0, 12.0), Some(8.0), 12.0);
    let beat_frames = (f64::from(DEVICE_SAMPLE_RATE) * 0.5).round() as usize;
    let search_radius = (f64::from(DEVICE_SAMPLE_RATE) * 0.02).round() as usize;

    for beat in 1..20 {
        let center = (4 + beat) * beat_frames;
        let (master_peak, master_level) = strongest_peak_near(&master, center, search_radius);
        let (follower_peak, follower_level) = strongest_peak_near(&follower, center, search_radius);
        assert!(
            master_level > 0.1 && follower_level > 0.1,
            "beat {beat}: missing synthetic transient, master {master_level}, follower {follower_level}"
        );
        let diff = follower_peak as isize - master_peak as isize;
        assert!(
            diff.abs() <= 1,
            "beat {beat}: synthetic transient offset {diff} samples"
        );
    }
}
