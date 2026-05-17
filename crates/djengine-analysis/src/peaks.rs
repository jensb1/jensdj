use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Peak {
    pub min: f32,
    pub max: f32,
    pub rms: f32,
}

pub fn extract_peaks(samples: &[f32], channels: usize, points: usize) -> Vec<Peak> {
    if samples.is_empty() || channels == 0 || points == 0 {
        return Vec::new();
    }

    let frames = samples.len() / channels;
    if frames == 0 {
        return Vec::new();
    }

    let mut peaks = Vec::with_capacity(points);
    for point in 0..points {
        let start_frame = proportional_frame(point, frames, points);
        let mut end_frame = proportional_frame(point + 1, frames, points);
        if end_frame <= start_frame {
            end_frame = (start_frame + 1).min(frames);
        }

        peaks.push(peak_for_samples(
            &samples[start_frame * channels..end_frame * channels],
        ));
    }

    peaks
}

fn proportional_frame(point: usize, frames: usize, points: usize) -> usize {
    ((point as u128 * frames as u128) / points as u128) as usize
}

fn peak_for_samples(samples: &[f32]) -> Peak {
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    let mut sum_squares = 0.0f64;
    let mut count = 0usize;

    for &sample in samples {
        let sample = if sample.is_finite() { sample } else { 0.0 };
        min = min.min(sample);
        max = max.max(sample);
        sum_squares += f64::from(sample) * f64::from(sample);
        count += 1;
    }

    if count == 0 {
        return Peak {
            min: 0.0,
            max: 0.0,
            rms: 0.0,
        };
    }

    Peak {
        min,
        max,
        rms: (sum_squares / count as f64).sqrt() as f32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 0.0001,
            "expected {actual} to be close to {expected}"
        );
    }

    #[test]
    fn peaks_extracts_mono_windows() {
        let peaks = extract_peaks(&[-1.0, 0.5, 0.25, -0.25], 1, 2);

        assert_eq!(peaks.len(), 2);
        assert_close(peaks[0].min, -1.0);
        assert_close(peaks[0].max, 0.5);
        assert_close(peaks[0].rms, 0.625f32.sqrt());
        assert_close(peaks[1].min, -0.25);
        assert_close(peaks[1].max, 0.25);
        assert_close(peaks[1].rms, 0.25);
    }

    #[test]
    fn peaks_include_all_interleaved_channels_in_each_window() {
        let peaks = extract_peaks(&[-1.0, 0.5, 0.25, -0.25], 2, 1);

        assert_eq!(peaks.len(), 1);
        assert_close(peaks[0].min, -1.0);
        assert_close(peaks[0].max, 0.5);
        assert_close(peaks[0].rms, 0.34375f32.sqrt());
    }

    #[test]
    fn peaks_returns_requested_points_when_points_exceed_frames() {
        let peaks = extract_peaks(&[0.25, -0.5], 1, 4);

        assert_eq!(peaks.len(), 4);
        assert_eq!(
            peaks,
            vec![
                Peak {
                    min: 0.25,
                    max: 0.25,
                    rms: 0.25
                },
                Peak {
                    min: 0.25,
                    max: 0.25,
                    rms: 0.25
                },
                Peak {
                    min: -0.5,
                    max: -0.5,
                    rms: 0.5
                },
                Peak {
                    min: -0.5,
                    max: -0.5,
                    rms: 0.5
                },
            ]
        );
    }

    #[test]
    fn peaks_returns_empty_for_invalid_shape() {
        assert!(extract_peaks(&[1.0, 2.0], 0, 4).is_empty());
        assert!(extract_peaks(&[1.0, 2.0], 2, 0).is_empty());
        assert!(extract_peaks(&[], 2, 4).is_empty());
    }
}
