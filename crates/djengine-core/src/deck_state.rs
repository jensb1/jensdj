use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DeckPosition {
    pub global_frame_at_start: u64,
    pub source_frame_at_start: f64,
    pub source_sample_rate: f64,
    pub device_sample_rate: f64,
    pub ratio: f64,
}

impl DeckPosition {
    pub fn new(
        global_frame_at_start: u64,
        source_frame_at_start: f64,
        source_sample_rate: f64,
        device_sample_rate: f64,
        ratio: f64,
    ) -> Self {
        Self {
            global_frame_at_start,
            source_frame_at_start,
            source_sample_rate: source_sample_rate.max(1.0),
            device_sample_rate: device_sample_rate.max(1.0),
            ratio: ratio.max(f64::EPSILON),
        }
    }

    pub fn global_to_source(&self, global_frame: u64) -> f64 {
        let delta_global = global_frame as f64 - self.global_frame_at_start as f64;
        self.source_frame_at_start
            + delta_global * self.ratio * self.source_sample_rate / self.device_sample_rate
    }

    pub fn source_to_global(&self, source_frame: f64) -> f64 {
        self.global_frame_at_start as f64
            + (source_frame - self.source_frame_at_start) * self.device_sample_rate
                / (self.ratio * self.source_sample_rate)
    }

    pub fn anchor_at(&mut self, global_frame: u64) {
        self.source_frame_at_start = self.global_to_source(global_frame);
        self.global_frame_at_start = global_frame;
    }

    pub fn seek(&mut self, global_frame: u64, source_frame: f64) {
        self.global_frame_at_start = global_frame;
        self.source_frame_at_start = source_frame.max(0.0);
    }

    pub fn set_ratio_at(&mut self, global_frame: u64, ratio: f64) {
        self.anchor_at(global_frame);
        self.ratio = ratio.max(f64::EPSILON);
    }
}

#[cfg(test)]
mod tests {
    use super::DeckPosition;

    #[test]
    fn affine_map_round_trips() {
        let pos = DeckPosition::new(100, 1_000.0, 48_000.0, 48_000.0, 1.25);
        for source in [1_000.0, 1_200.0, 10_000.0] {
            let global = pos.source_to_global(source).round() as u64;
            assert!((pos.global_to_source(global) - source).abs() < 0.75);
        }
    }

    #[test]
    fn ratio_change_preserves_current_source_position() {
        let mut pos = DeckPosition::new(0, 0.0, 48_000.0, 48_000.0, 1.0);
        pos.set_ratio_at(48_000, 2.0);
        assert!((pos.source_frame_at_start - 48_000.0).abs() < f64::EPSILON);
        assert!((pos.global_to_source(72_000) - 96_000.0).abs() < f64::EPSILON);
    }
}
