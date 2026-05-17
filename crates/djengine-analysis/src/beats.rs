use crate::bpm::{estimate_beat_grid_from_mono, estimate_beat_grid_from_mono_with_hint};

#[derive(Debug, Clone, PartialEq)]
pub struct BeatAnalysis {
    pub bpm: f32,
    pub beats: Vec<f32>,
}

pub fn extract_beats(samples: &[f32], sample_rate: u32) -> BeatAnalysis {
    let (bpm, beats) =
        estimate_beat_grid_from_mono(samples, sample_rate).unwrap_or_else(|| (0.0, Vec::new()));

    BeatAnalysis { bpm, beats }
}

pub fn extract_beats_with_bpm_hint(
    samples: &[f32],
    sample_rate: u32,
    bpm_hint: Option<f32>,
) -> BeatAnalysis {
    let (bpm, beats) = estimate_beat_grid_from_mono_with_hint(samples, sample_rate, bpm_hint)
        .unwrap_or_else(|| (0.0, Vec::new()));

    BeatAnalysis { bpm, beats }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_RATE: u32 = 48_000;

    #[test]
    fn extracts_beats_from_generated_click_tracks() {
        for bpm in [100.0, 120.0, 128.0] {
            let samples = click_track(bpm, 12.0);
            let analysis = extract_beats(&samples, SAMPLE_RATE);

            assert!(
                (analysis.bpm - bpm).abs() < 0.25,
                "expected {bpm}, got {}",
                analysis.bpm
            );
            assert!(analysis.beats.len() >= 10);

            let expected_interval = 60.0 / bpm;
            for interval in analysis
                .beats
                .windows(2)
                .take(8)
                .map(|pair| pair[1] - pair[0])
            {
                assert!(
                    (interval - expected_interval).abs() < 0.002,
                    "expected interval {expected_interval}, got {interval}"
                );
            }
        }
    }

    #[test]
    fn returns_empty_beats_when_none_are_detected() {
        let samples = vec![0.0; SAMPLE_RATE as usize * 4];
        let analysis = extract_beats(&samples, SAMPLE_RATE);

        assert_eq!(analysis.bpm, 0.0);
        assert!(analysis.beats.is_empty());
    }

    #[test]
    fn regular_subdivisions_produce_normalized_beat_grid() {
        let samples = click_track(240.0, 8.0);
        let analysis = extract_beats(&samples, SAMPLE_RATE);

        assert!(
            (analysis.bpm - 120.0).abs() < 0.25,
            "expected normalized 120 BPM, got {}",
            analysis.bpm
        );

        for interval in analysis
            .beats
            .windows(2)
            .take(8)
            .map(|pair| pair[1] - pair[0])
        {
            assert!((interval - 0.5).abs() < 0.002, "got {interval}");
        }
    }

    fn click_track(bpm: f32, seconds: f32) -> Vec<f32> {
        let len = (SAMPLE_RATE as f32 * seconds).round() as usize;
        let mut samples = vec![0.0; len];
        let interval = 60.0 / bpm;
        let click_len = (SAMPLE_RATE as f32 * 0.01).round() as usize;
        let mut beat_time = 0.0;

        while beat_time < seconds {
            let start = (beat_time * SAMPLE_RATE as f32).round() as usize;

            for offset in 0..click_len {
                let index = start + offset;
                if index >= samples.len() {
                    break;
                }

                let envelope = 1.0 - offset as f32 / click_len as f32;
                samples[index] += envelope;
            }

            beat_time += interval;
        }

        samples
    }
}
