use serde::{Deserialize, Serialize};

use crate::beat_grid::next_downbeat_after_beat;
use crate::BeatGrid;

#[derive(Debug, Clone, Copy)]
pub struct SyncInput<'a> {
    pub follower_grid: &'a BeatGrid,
    pub master_grid: &'a BeatGrid,
    pub follower_source_frame: f64,
    pub master_source_frame: f64,
    pub current_global_frame: u64,
    pub device_sample_rate: f64,
    pub follower_source_sample_rate: f64,
    pub master_source_sample_rate: f64,
    pub master_ratio: f64,
    pub follower_original_bpm: f64,
    pub master_original_bpm: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SyncSeek {
    pub follower_source_frame: u64,
    pub follower_ratio: f64,
    pub target_global_frame: u64,
    pub master_downbeat_seconds: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SyncError {
    #[error("beat grid is empty")]
    EmptyGrid,
    #[error("invalid sync input")]
    InvalidInput,
}

pub fn compute_sync_seek(input: SyncInput<'_>) -> Result<SyncSeek, SyncError> {
    validate(&input)?;

    let master_time = input.master_source_frame / input.master_source_sample_rate;
    let master_beat = input
        .master_grid
        .beat_at_time(master_time)
        .ok_or(SyncError::EmptyGrid)?;
    let target_master_beat =
        next_downbeat_after_beat(master_beat, input.master_grid.beats_per_bar.max(1));
    let target_master_time = input
        .master_grid
        .time_at_beat(target_master_beat)
        .ok_or(SyncError::EmptyGrid)?;

    let seconds_until_target = (target_master_time - master_time).max(0.0);
    let global_frames_until =
        seconds_until_target * input.device_sample_rate / input.master_ratio.max(f64::EPSILON);
    let target_global_frame = input
        .current_global_frame
        .saturating_add(global_frames_until.round().max(0.0) as u64);

    let follower_time = input.follower_source_frame / input.follower_source_sample_rate;
    let follower_beat = input
        .follower_grid
        .beat_at_time(follower_time)
        .ok_or(SyncError::EmptyGrid)?;
    let target_follower_beat =
        next_downbeat_after_beat(follower_beat, input.follower_grid.beats_per_bar.max(1));
    let target_follower_time = input
        .follower_grid
        .time_at_beat(target_follower_beat)
        .ok_or(SyncError::EmptyGrid)?;

    let master_effective_bpm = input.master_original_bpm * input.master_ratio;
    let follower_ratio = master_effective_bpm / input.follower_original_bpm;

    Ok(SyncSeek {
        follower_source_frame: (target_follower_time * input.follower_source_sample_rate)
            .round()
            .max(0.0) as u64,
        follower_ratio,
        target_global_frame,
        master_downbeat_seconds: target_master_time,
    })
}

fn validate(input: &SyncInput<'_>) -> Result<(), SyncError> {
    if input.follower_grid.is_empty() || input.master_grid.is_empty() {
        return Err(SyncError::EmptyGrid);
    }
    let valid = input.follower_source_frame.is_finite()
        && input.master_source_frame.is_finite()
        && input.device_sample_rate.is_finite()
        && input.follower_source_sample_rate.is_finite()
        && input.master_source_sample_rate.is_finite()
        && input.master_ratio.is_finite()
        && input.follower_original_bpm.is_finite()
        && input.master_original_bpm.is_finite()
        && input.device_sample_rate > 0.0
        && input.follower_source_sample_rate > 0.0
        && input.master_source_sample_rate > 0.0
        && input.master_ratio > 0.0
        && input.follower_original_bpm > 0.0
        && input.master_original_bpm > 0.0;
    if valid {
        Ok(())
    } else {
        Err(SyncError::InvalidInput)
    }
}

#[cfg(test)]
mod tests {
    use super::{compute_sync_seek, SyncInput};
    use crate::BeatGrid;

    #[test]
    fn sync_seek_targets_next_downbeat_and_ratio() {
        let master = BeatGrid::new((0..64).map(|i| i as f32 * 0.5).collect());
        let follower = BeatGrid::new((0..64).map(|i| i as f32 * 0.6).collect());
        let seek = compute_sync_seek(SyncInput {
            follower_grid: &follower,
            master_grid: &master,
            follower_source_frame: 0.0,
            master_source_frame: 24_000.0,
            current_global_frame: 48_000,
            device_sample_rate: 48_000.0,
            follower_source_sample_rate: 48_000.0,
            master_source_sample_rate: 48_000.0,
            master_ratio: 1.0,
            follower_original_bpm: 100.0,
            master_original_bpm: 120.0,
        })
        .unwrap();

        assert_eq!(seek.target_global_frame, 120_000);
        assert_eq!(seek.follower_source_frame, 115_200);
        assert!((seek.follower_ratio - 1.2).abs() < 1.0e-12);
    }

    #[test]
    fn master_ratio_contributes_to_follower_ratio() {
        let grid = BeatGrid::new((0..64).map(|i| i as f32 * 0.5).collect());
        let seek = compute_sync_seek(SyncInput {
            follower_grid: &grid,
            master_grid: &grid,
            follower_source_frame: 96_000.0,
            master_source_frame: 96_000.0,
            current_global_frame: 0,
            device_sample_rate: 48_000.0,
            follower_source_sample_rate: 48_000.0,
            master_source_sample_rate: 48_000.0,
            master_ratio: 0.5,
            follower_original_bpm: 100.0,
            master_original_bpm: 120.0,
        })
        .unwrap();
        assert!((seek.follower_ratio - 0.6).abs() < 1.0e-12);
    }
}
