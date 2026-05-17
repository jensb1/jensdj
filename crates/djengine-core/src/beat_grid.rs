use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeatGrid {
    pub beats: Vec<f32>,
    pub bar_duration: f32,
    pub beats_per_bar: u32,
}

impl BeatGrid {
    pub fn new(beats: Vec<f32>) -> Self {
        Self::with_beats_per_bar(beats, 4)
    }

    pub fn with_beats_per_bar(mut beats: Vec<f32>, beats_per_bar: u32) -> Self {
        beats.retain(|beat| beat.is_finite());
        beats.sort_by(|a, b| a.total_cmp(b));
        beats.dedup_by(|a, b| (*a - *b).abs() < f32::EPSILON);

        let beats_per_bar = beats_per_bar.max(1);
        let beat_duration = median_interval(&beats).unwrap_or(0.5);
        Self {
            beats,
            bar_duration: beat_duration * beats_per_bar as f32,
            beats_per_bar,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.beats.is_empty()
    }

    pub fn beat_duration(&self) -> Option<f64> {
        if let Some((_, slope)) = self.fitted_regular_line() {
            return Some(slope);
        }
        median_interval(&self.beats)
            .or_else(|| {
                (self.bar_duration.is_finite() && self.bar_duration > 0.0)
                    .then(|| self.bar_duration / self.beats_per_bar.max(1) as f32)
            })
            .map(f64::from)
    }

    pub fn nearest_beat(&self, seconds: f64) -> Option<f64> {
        if !seconds.is_finite() || self.beats.is_empty() {
            return None;
        }

        let idx = self.partition_point(seconds as f32);
        match (idx.checked_sub(1), self.beats.get(idx)) {
            (Some(prev), Some(next)) => {
                let prev_time = f64::from(self.beats[prev]);
                let next_time = f64::from(*next);
                if (seconds - prev_time).abs() <= (next_time - seconds).abs() {
                    Some(prev as f64)
                } else {
                    Some(idx as f64)
                }
            }
            (Some(prev), None) => Some(prev as f64),
            (None, Some(_)) => Some(0.0),
            (None, None) => None,
        }
    }

    pub fn beat_at_time(&self, seconds: f64) -> Option<f64> {
        if !seconds.is_finite() || self.beats.is_empty() {
            return None;
        }
        if let Some((intercept, slope)) = self.fitted_regular_line() {
            return Some((seconds - intercept) / slope);
        }
        if self.beats.len() == 1 {
            let duration = self.beat_duration()?;
            return Some((seconds - f64::from(self.beats[0])) / duration);
        }

        let idx = self.partition_point(seconds as f32);
        if idx == 0 {
            let duration = self.beat_duration()?;
            return Some((seconds - f64::from(self.beats[0])) / duration);
        }
        if idx >= self.beats.len() {
            let duration = self.beat_duration()?;
            return Some(
                (self.beats.len() - 1) as f64
                    + (seconds - f64::from(*self.beats.last()?)) / duration,
            );
        }

        let prev = f64::from(self.beats[idx - 1]);
        let next = f64::from(self.beats[idx]);
        let interval = next - prev;
        if interval <= f64::EPSILON {
            Some((idx - 1) as f64)
        } else {
            Some((idx - 1) as f64 + (seconds - prev) / interval)
        }
    }

    pub fn time_at_beat(&self, beat: f64) -> Option<f64> {
        if !beat.is_finite() || self.beats.is_empty() {
            return None;
        }
        if let Some((intercept, slope)) = self.fitted_regular_line() {
            return Some(intercept + beat * slope);
        }
        if self.beats.len() == 1 {
            return Some(f64::from(self.beats[0]) + beat * self.beat_duration()?);
        }

        if beat <= 0.0 {
            return Some(f64::from(self.beats[0]) + beat * self.beat_duration()?);
        }

        let lower = beat.floor() as usize;
        let frac = beat - lower as f64;
        if lower + 1 < self.beats.len() {
            let start = f64::from(self.beats[lower]);
            let end = f64::from(self.beats[lower + 1]);
            Some(start + (end - start) * frac)
        } else {
            let last_idx = self.beats.len() - 1;
            Some(
                f64::from(self.beats[last_idx])
                    + (beat - last_idx as f64) * self.beat_duration()?,
            )
        }
    }

    pub fn nearest_downbeat(&self, seconds: f64) -> Option<f64> {
        let beat = self.nearest_beat(seconds)?;
        let beats_per_bar = f64::from(self.beats_per_bar.max(1));
        Some((beat / beats_per_bar).round() * beats_per_bar)
    }

    pub fn next_downbeat_after(&self, seconds: f64) -> Option<f64> {
        let beat = self.beat_at_time(seconds)?;
        Some(next_downbeat_after_beat(beat, self.beats_per_bar))
    }

    pub fn phase_aligned_downbeat(&self, reference_beat: f64) -> Option<f64> {
        if self.beats.is_empty() || !reference_beat.is_finite() {
            return None;
        }
        let beats_per_bar = f64::from(self.beats_per_bar.max(1));
        Some((reference_beat / beats_per_bar).round() * beats_per_bar)
    }

    fn partition_point(&self, seconds: f32) -> usize {
        self.beats.partition_point(|beat| *beat < seconds)
    }

    fn fitted_regular_line(&self) -> Option<(f64, f64)> {
        if self.beats.len() < 8 {
            return None;
        }

        let n = self.beats.len() as f64;
        let mean_index = (n - 1.0) * 0.5;
        let mean_time = self.beats.iter().map(|beat| f64::from(*beat)).sum::<f64>() / n;

        let mut numerator = 0.0;
        let mut denominator = 0.0;
        for (index, beat) in self.beats.iter().enumerate() {
            let x = index as f64 - mean_index;
            numerator += x * (f64::from(*beat) - mean_time);
            denominator += x * x;
        }
        if denominator <= f64::EPSILON {
            return None;
        }

        let slope = numerator / denominator;
        if !slope.is_finite() || slope <= f64::EPSILON {
            return None;
        }
        let intercept = mean_time - slope * mean_index;

        let max_residual = self
            .beats
            .iter()
            .enumerate()
            .map(|(index, beat)| (f64::from(*beat) - (intercept + index as f64 * slope)).abs())
            .fold(0.0, f64::max);

        if max_residual <= (slope * 0.01).max(1.0e-4) {
            Some((intercept, slope))
        } else {
            None
        }
    }
}

pub fn next_downbeat_after_beat(beat: f64, beats_per_bar: u32) -> f64 {
    let beats_per_bar = f64::from(beats_per_bar.max(1));
    let downbeat = (beat / beats_per_bar).ceil() * beats_per_bar;
    if (downbeat - beat).abs() < 1.0e-9 {
        downbeat + beats_per_bar
    } else {
        downbeat
    }
}

fn median_interval(beats: &[f32]) -> Option<f32> {
    let mut intervals: Vec<f32> = beats
        .windows(2)
        .filter_map(|window| {
            let interval = window[1] - window[0];
            (interval.is_finite() && interval > 0.0).then_some(interval)
        })
        .collect();
    if intervals.is_empty() {
        return None;
    }
    intervals.sort_by(|a, b| a.total_cmp(b));
    let middle = intervals.len() / 2;
    if intervals.len().is_multiple_of(2) {
        Some((intervals[middle - 1] + intervals[middle]) * 0.5)
    } else {
        Some(intervals[middle])
    }
}

#[cfg(test)]
mod tests {
    use super::{next_downbeat_after_beat, BeatGrid};

    #[test]
    fn empty_grid_returns_none_for_phase_queries() {
        let grid = BeatGrid::new(Vec::new());
        assert!(grid.nearest_beat(1.0).is_none());
        assert!(grid.beat_at_time(1.0).is_none());
        assert!(grid.time_at_beat(1.0).is_none());
    }

    #[test]
    fn single_beat_extrapolates_from_bar_duration() {
        let mut grid = BeatGrid::new(vec![2.0]);
        grid.bar_duration = 2.0;
        assert!((grid.beat_at_time(2.5).unwrap() - 1.0).abs() < 1.0e-6);
        assert!((grid.time_at_beat(3.0).unwrap() - 3.5).abs() < 1.0e-6);
    }

    #[test]
    fn sparse_grid_interpolates_and_extrapolates() {
        let grid = BeatGrid::new(vec![0.0, 0.5, 1.0, 1.5]);
        assert!((grid.beat_at_time(0.75).unwrap() - 1.5).abs() < 1.0e-6);
        assert!((grid.time_at_beat(2.5).unwrap() - 1.25).abs() < 1.0e-6);
        assert!((grid.beat_at_time(2.0).unwrap() - 4.0).abs() < 1.0e-6);
    }

    #[test]
    fn downbeats_advance_when_already_on_grid() {
        assert_eq!(next_downbeat_after_beat(0.0, 4), 4.0);
        assert_eq!(next_downbeat_after_beat(3.5, 4), 4.0);
        assert_eq!(next_downbeat_after_beat(4.0, 4), 8.0);
    }
}
