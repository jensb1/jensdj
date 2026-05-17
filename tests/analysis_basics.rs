use std::path::PathBuf;

use djengine::analysis::{decode_file, detect_bpm, extract_beats, extract_peaks};

const SAMPLE_RATE: u32 = 48_000;

fn temp_wav_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "djengine-analysis-basics-{}.wav",
        std::process::id()
    ))
}

fn click_track_wav(bpm: f32, seconds: f32) -> Vec<u8> {
    let frames = (SAMPLE_RATE as f32 * seconds).round() as usize;
    let interval = 60.0 / bpm;
    let mut samples = vec![0_i16; frames];
    let mut beat_time = 0.0;
    while beat_time < seconds {
        let start = (beat_time * SAMPLE_RATE as f32).round() as usize;
        for offset in 0..128 {
            if start + offset < samples.len() {
                let gain = 1.0 - offset as f32 / 128.0;
                samples[start + offset] = (gain * i16::MAX as f32) as i16;
            }
        }
        beat_time += interval;
    }

    let data_len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

#[test]
fn decodes_and_analyzes_synthetic_click_track() {
    let path = temp_wav_path();
    std::fs::write(&path, click_track_wav(120.0, 8.0)).unwrap();

    let audio = decode_file(&path).unwrap();
    assert_eq!(audio.sample_rate, SAMPLE_RATE);
    assert_eq!(audio.channels, 1);
    assert!((detect_bpm(&path).unwrap() - 120.0).abs() < 0.5);

    let analysis = extract_beats(&audio.samples, audio.sample_rate);
    assert!((analysis.bpm - 120.0).abs() < 0.5);
    assert!(analysis.beats.len() >= 8);
    assert_eq!(extract_peaks(&audio.samples, audio.channels, 32).len(), 32);

    let _ = std::fs::remove_file(path);
}
