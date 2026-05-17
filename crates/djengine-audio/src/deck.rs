use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use djengine_core::{BeatGrid, DeckPosition};
use serde::{Deserialize, Serialize};
use signalsmith_stretch::Stretch;

const STRETCH_BLOCK_FRAMES: usize = 2048;
const MIN_TEMPO_RATIO: f64 = 0.25;
const MAX_TEMPO_RATIO: f64 = 4.0;
const DIRECT_RATIO_EPSILON: f64 = 0.002;
const TRANSIENT_LOCK_FULL_SECONDS: f64 = 0.015;
const TRANSIENT_LOCK_FADE_SECONDS: f64 = 0.010;
const LOOP_CROSSFADE_SECONDS: f64 = 0.005;

#[derive(Debug, Clone)]
pub struct DecodedTrack {
    pub sample_rate: u32,
    pub channels: usize,
    pub samples: Arc<Vec<f32>>,
    pub beat_grid: Option<BeatGrid>,
    pub original_bpm: Option<f64>,
}

impl DecodedTrack {
    pub fn new(
        sample_rate: u32,
        channels: usize,
        samples: Vec<f32>,
        beat_grid: Option<BeatGrid>,
        original_bpm: Option<f64>,
    ) -> Self {
        Self {
            sample_rate,
            channels: channels.max(1),
            samples: Arc::new(samples),
            beat_grid,
            original_bpm,
        }
    }

    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels.max(1)
    }

    pub fn duration_seconds(&self) -> f64 {
        self.frames() as f64 / f64::from(self.sample_rate.max(1))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct LoopState {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub active: bool,
}

impl LoopState {
    pub fn frames(&self, sample_rate: u32) -> Option<(f64, f64)> {
        if !self.active
            || !self.start_seconds.is_finite()
            || !self.end_seconds.is_finite()
            || self.end_seconds <= self.start_seconds
        {
            return None;
        }
        let rate = f64::from(sample_rate.max(1));
        Some((self.start_seconds.max(0.0) * rate, self.end_seconds * rate))
    }
}

pub struct Deck {
    pub track: DecodedTrack,
    pub position: DeckPosition,
    pub loop_state: LoopState,
    pub playing: bool,
    pub synced_to_master: bool,
    pub next_tick_frame: u64,
    stretch: Stretch,
    stretch_input: Vec<f32>,
    stretch_output: Vec<f32>,
    stretch_input_remainder: f64,
    stretch_latency_frames: u64,
    stretch_next_source_frame: Option<f64>,
    volume: AtomicU32,
    ratio: AtomicU64,
    original_bpm: f64,
}

impl Deck {
    pub fn new(track: DecodedTrack, device_sample_rate: u32, global_frame: u64) -> Self {
        let track_channels = track.channels.max(1);
        let track_sample_rate = track.sample_rate.max(1);
        let device_sample_rate = device_sample_rate.max(1);
        let original_bpm = track.original_bpm.unwrap_or_else(|| {
            track
                .beat_grid
                .as_ref()
                .and_then(|grid| grid.beat_duration())
                .map(|duration| 60.0 / duration)
                .unwrap_or(120.0)
        });
        let stretch = Stretch::preset_cheaper(track_channels as u32, device_sample_rate);
        let stretch_latency_frames = stretch_latency_frames(&stretch, 1.0);
        Self {
            position: DeckPosition::new(
                global_frame,
                0.0,
                f64::from(track_sample_rate),
                f64::from(device_sample_rate),
                1.0,
            ),
            track,
            loop_state: LoopState::default(),
            playing: false,
            synced_to_master: false,
            next_tick_frame: global_frame,
            stretch,
            stretch_input: vec![
                0.0;
                (max_stretch_input_frames(STRETCH_BLOCK_FRAMES, MAX_TEMPO_RATIO)
                    + 4)
                    * track_channels
            ],
            stretch_output: vec![0.0; STRETCH_BLOCK_FRAMES * track_channels],
            stretch_input_remainder: 0.0,
            stretch_latency_frames,
            stretch_next_source_frame: None,
            volume: AtomicU32::new(1.0_f32.to_bits()),
            ratio: AtomicU64::new(1.0_f64.to_bits()),
            original_bpm,
        }
    }

    pub fn volume(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed))
    }

    pub fn set_volume(&self, volume: f32) {
        self.volume
            .store(volume.clamp(0.0, 4.0).to_bits(), Ordering::Relaxed);
    }

    pub fn ratio(&self) -> f64 {
        f64::from_bits(self.ratio.load(Ordering::Relaxed))
    }

    pub fn set_ratio(&mut self, ratio: f64, global_frame: u64) {
        let ratio = sanitize_ratio(ratio);
        self.position.set_ratio_at(global_frame, ratio);
        self.ratio.store(ratio.to_bits(), Ordering::Relaxed);
        self.stretch_latency_frames = stretch_latency_frames(&self.stretch, ratio);
    }

    pub fn original_bpm(&self) -> f64 {
        self.original_bpm
    }

    pub fn set_original_bpm(&mut self, bpm: f64) {
        if bpm.is_finite() && bpm > 0.0 {
            self.original_bpm = bpm;
        }
    }

    pub fn play(&mut self, global_frame: u64) {
        self.position.anchor_at(global_frame);
        self.playing = true;
    }

    pub fn pause(&mut self, global_frame: u64) {
        self.position.anchor_at(global_frame);
        self.playing = false;
    }

    pub fn stop(&mut self, global_frame: u64) {
        self.position.seek(global_frame, 0.0);
        self.reset_stretcher();
        self.playing = false;
    }

    pub fn seek_seconds(&mut self, seconds: f64, global_frame: u64) {
        let source_frame = seconds.max(0.0) * f64::from(self.track.sample_rate.max(1));
        self.position.seek(global_frame, source_frame);
        self.reset_stretcher();
    }

    pub fn seek_source_frame_at_global(&mut self, source_frame: f64, global_frame: u64) {
        self.position.seek(global_frame, source_frame);
        self.reset_stretcher();
    }

    pub fn source_frame_at(&self, global_frame: u64) -> f64 {
        self.position.global_to_source(global_frame)
    }

    pub fn render_add(&mut self, global_start: u64, output_channels: usize, output: &mut [f32]) {
        if !self.playing || output_channels == 0 {
            return;
        }

        let frames = output.len() / output_channels;
        let track_frames = self.track.frames();
        if track_frames == 0 {
            self.playing = false;
            return;
        }

        let mut frame_offset = 0;
        while frame_offset < frames && self.playing {
            let global = global_start.saturating_add(frame_offset as u64);
            self.wrap_loop_at_global(global);
            let ratio = self.ratio();
            let chunk_frames = (frames - frame_offset).min(STRETCH_BLOCK_FRAMES).min(
                self.frames_until_loop_wrap(global)
                    .unwrap_or(STRETCH_BLOCK_FRAMES),
            );
            if (ratio - 1.0).abs() <= DIRECT_RATIO_EPSILON {
                self.render_direct_chunk(
                    global,
                    output_channels,
                    &mut output[frame_offset * output_channels
                        ..(frame_offset + chunk_frames) * output_channels],
                );
            } else {
                self.render_stretched_chunk(
                    global,
                    chunk_frames,
                    output_channels,
                    &mut output[frame_offset * output_channels
                        ..(frame_offset + chunk_frames) * output_channels],
                );
            }
            frame_offset += chunk_frames;
        }
    }

    fn render_direct_chunk(
        &mut self,
        global_start: u64,
        output_channels: usize,
        output: &mut [f32],
    ) {
        let frames = output.len() / output_channels;
        let volume = self.volume();
        for frame_idx in 0..frames {
            let global = global_start.saturating_add(frame_idx as u64);
            let Some(source) = self.source_for_render(global) else {
                break;
            };
            if source < 0.0 {
                continue;
            }

            for out_ch in 0..output_channels {
                let sample = self.sample_at_source(source, out_ch) * volume;
                output[frame_idx * output_channels + out_ch] += sample;
            }
        }
    }

    fn render_stretched_chunk(
        &mut self,
        global_start: u64,
        output_frames: usize,
        output_channels: usize,
        output: &mut [f32],
    ) {
        let channels = self.track.channels.max(1);
        let ratio = self.ratio();
        let source_frames_per_input_frame = self.source_frames_per_device_frame();
        let wanted_input_frames = output_frames as f64 * ratio + self.stretch_input_remainder;
        let input_frames = (wanted_input_frames.floor() as usize)
            .max(1)
            .min(self.stretch_input.len() / channels);
        self.stretch_input_remainder = wanted_input_frames - input_frames as f64;
        if input_frames == 0 {
            return;
        }

        let source_start = match self.stretch_next_source_frame {
            Some(source_frame) => source_frame,
            None => {
                let compensated_global_start =
                    global_start.saturating_add(self.stretch_latency_frames);
                self.position.global_to_source(compensated_global_start)
            }
        };
        let track_end = self.track.frames().saturating_sub(1) as f64;
        let mut filled_input_frames = 0;
        let mut reached_end = false;
        for input_frame in 0..input_frames {
            let source = source_start + input_frame as f64 * source_frames_per_input_frame;
            let source = self.loop_adjusted_source(source);
            if source < 0.0 || source >= track_end {
                if source >= track_end && self.loop_state.frames(self.track.sample_rate).is_none() {
                    reached_end = true;
                }
                for ch in 0..channels {
                    self.stretch_input[input_frame * channels + ch] = 0.0;
                }
                filled_input_frames += 1;
                continue;
            }
            let body_gain = 1.0 - self.transient_body_protection_weight(source).unwrap_or(0.0);
            for ch in 0..channels {
                self.stretch_input[input_frame * channels + ch] =
                    self.sample_at_source(source, ch) * body_gain;
            }
            filled_input_frames += 1;
        }
        self.stretch_next_source_frame =
            Some(source_start + filled_input_frames as f64 * source_frames_per_input_frame);
        if filled_input_frames == 0 {
            return;
        }

        let input_len = filled_input_frames * channels;
        let output_len = output_frames * channels;
        self.stretch.process(
            &self.stretch_input[..input_len],
            &mut self.stretch_output[..output_len],
        );
        if reached_end {
            self.playing = false;
        }

        let volume = self.volume();
        for frame in 0..output_frames {
            let global = global_start.saturating_add(frame as u64);
            let direct_source = self.direct_source_for_global(global);
            let direct_weight = direct_source
                .and_then(|source| self.direct_attack_weight(source))
                .unwrap_or(0.0);
            for out_ch in 0..output_channels {
                let src_ch = out_ch.min(channels - 1);
                let stretched = self.stretch_output[frame * channels + src_ch];
                let sample = match (direct_source, direct_weight > 0.0) {
                    (Some(source), true) => {
                        let direct = self.sample_at_source(source, out_ch);
                        stretched * (1.0 - direct_weight) + direct * direct_weight
                    }
                    _ => stretched,
                };
                output[frame * output_channels + out_ch] += sample * volume;
            }
        }
    }

    fn source_for_render(&mut self, global_frame: u64) -> Option<f64> {
        let mut source = self.position.global_to_source(global_frame);

        if let Some((loop_start, loop_end)) = self.loop_state.frames(self.track.sample_rate) {
            if source >= loop_end {
                let len = (loop_end - loop_start).max(1.0);
                source = loop_start + (source - loop_start).rem_euclid(len);
                self.position.seek(global_frame, source);
            }
        }

        if source < 0.0 {
            return Some(source);
        }
        let track_frames = self.track.frames();
        if source >= track_frames.saturating_sub(1) as f64 {
            self.playing = false;
            self.position.seek(global_frame, track_frames as f64);
            None
        } else {
            Some(source)
        }
    }

    fn loop_adjusted_source(&self, source: f64) -> f64 {
        if let Some((loop_start, loop_end)) = self.loop_state.frames(self.track.sample_rate) {
            if source >= loop_end {
                let len = (loop_end - loop_start).max(1.0);
                return loop_start + (source - loop_start).rem_euclid(len);
            }
        }
        source
    }

    fn wrap_loop_at_global(&mut self, global_frame: u64) {
        let Some((loop_start, loop_end)) = self.loop_state.frames(self.track.sample_rate) else {
            return;
        };
        let source = self.position.global_to_source(global_frame);
        if source < loop_end {
            return;
        }

        let len = (loop_end - loop_start).max(1.0);
        let wrapped = loop_start + (source - loop_start).rem_euclid(len);
        self.position.seek(global_frame, wrapped);
    }

    fn frames_until_loop_wrap(&self, global_frame: u64) -> Option<usize> {
        let (_loop_start, loop_end) = self.loop_state.frames(self.track.sample_rate)?;
        let source = self.position.global_to_source(global_frame);
        if source >= loop_end {
            return Some(1);
        }

        let source_per_output_frame = self.ratio() * self.source_frames_per_device_frame();
        if !source_per_output_frame.is_finite() || source_per_output_frame <= 0.0 {
            return None;
        }

        let frames = ((loop_end - source) / source_per_output_frame).ceil() as usize;
        Some(frames.max(1))
    }

    fn direct_source_for_global(&self, global_frame: u64) -> Option<f64> {
        let source = self.loop_adjusted_source(self.position.global_to_source(global_frame));
        if source < 0.0 || source >= self.track.frames().saturating_sub(1) as f64 {
            None
        } else {
            Some(source)
        }
    }

    fn sample_at_source(&self, source: f64, out_channel: usize) -> f32 {
        let source = self.loop_adjusted_source(source);
        let Some((loop_start, loop_end)) = self.loop_state.frames(self.track.sample_rate) else {
            return sample_interpolated_at_source(&self.track, source, out_channel);
        };

        let loop_len = loop_end - loop_start;
        let crossfade_frames = (LOOP_CROSSFADE_SECONDS * f64::from(self.track.sample_rate.max(1)))
            .min(loop_len * 0.25);
        if crossfade_frames <= 1.0 {
            return sample_interpolated_at_source(&self.track, source, out_channel);
        }

        let crossfade_start = loop_end - crossfade_frames;
        if source < crossfade_start || source >= loop_end {
            return sample_interpolated_at_source(&self.track, source, out_channel);
        }

        let phase = ((source - crossfade_start) / crossfade_frames).clamp(0.0, 1.0) as f32;
        let wrapped_source = loop_start + (source - crossfade_start);
        let tail = sample_interpolated_at_source(&self.track, source, out_channel);
        let head = sample_interpolated_at_source(&self.track, wrapped_source, out_channel);
        tail * (1.0 - phase) + head * phase
    }

    fn transient_beat_delta_frames(&self, source_frame: f64) -> Option<f64> {
        if !self.synced_to_master {
            return None;
        }
        let grid = self.track.beat_grid.as_ref()?;
        let sample_rate = f64::from(self.track.sample_rate.max(1));
        let seconds = source_frame / sample_rate;
        let nearest = grid.nearest_beat(seconds)?.round();
        let beat_seconds = grid.time_at_beat(nearest)?;
        Some(source_frame - beat_seconds * sample_rate)
    }

    fn transient_body_protection_weight(&self, source_frame: f64) -> Option<f32> {
        let distance_frames = self.transient_beat_delta_frames(source_frame)?.abs();
        let sample_rate = f64::from(self.track.sample_rate.max(1));
        let full_frames = (TRANSIENT_LOCK_FULL_SECONDS * sample_rate).max(1.0);
        let fade_frames = (TRANSIENT_LOCK_FADE_SECONDS * sample_rate).max(1.0);
        let window_frames = full_frames + fade_frames;
        if distance_frames <= full_frames {
            Some(1.0)
        } else if distance_frames >= window_frames {
            Some(0.0)
        } else {
            let phase = (distance_frames - full_frames) / fade_frames;
            Some((0.5 + 0.5 * (std::f64::consts::PI * phase).cos()) as f32)
        }
    }

    fn direct_attack_weight(&self, source_frame: f64) -> Option<f32> {
        let delta_frames = self.transient_beat_delta_frames(source_frame)?;
        if delta_frames < 0.0 {
            return Some(0.0);
        }

        let sample_rate = f64::from(self.track.sample_rate.max(1));
        let full_frames = (TRANSIENT_LOCK_FULL_SECONDS * sample_rate).max(1.0);
        let fade_frames = (TRANSIENT_LOCK_FADE_SECONDS * sample_rate).max(1.0);
        let window_frames = full_frames + fade_frames;
        if delta_frames <= full_frames {
            Some(1.0)
        } else if delta_frames >= window_frames {
            Some(0.0)
        } else {
            let phase = (delta_frames - full_frames) / fade_frames;
            Some((0.5 + 0.5 * (std::f64::consts::PI * phase).cos()) as f32)
        }
    }

    fn reset_stretcher(&mut self) {
        self.stretch.reset();
        self.stretch_input_remainder = 0.0;
        self.stretch_next_source_frame = None;
    }

    fn source_frames_per_device_frame(&self) -> f64 {
        f64::from(self.track.sample_rate.max(1)) / self.position.device_sample_rate.max(1.0)
    }

    pub fn set_loop(&mut self, start_seconds: f64, end_seconds: f64, active: bool) {
        self.loop_state = LoopState {
            start_seconds,
            end_seconds,
            active,
        };
        self.reset_stretcher();
    }

    pub fn clear_loop(&mut self) {
        self.loop_state = LoopState::default();
        self.reset_stretcher();
    }

    pub fn set_loop_beats(&mut self, beats: f64, global_frame: u64) {
        if beats <= 0.0 || !beats.is_finite() {
            return;
        }
        let Some(grid) = self.track.beat_grid.as_ref() else {
            return;
        };
        let seconds =
            self.position.global_to_source(global_frame) / f64::from(self.track.sample_rate);
        let Some(nearest) = grid.nearest_beat(seconds) else {
            return;
        };
        let Some(start) = grid.time_at_beat(nearest.round()) else {
            return;
        };
        let Some(end) = grid.time_at_beat(nearest.round() + beats) else {
            return;
        };
        self.set_loop(start, end, true);
    }
}

fn sanitize_ratio(ratio: f64) -> f64 {
    if ratio.is_finite() {
        ratio.clamp(MIN_TEMPO_RATIO, MAX_TEMPO_RATIO)
    } else {
        1.0
    }
}

fn max_stretch_input_frames(output_frames: usize, max_ratio: f64) -> usize {
    (output_frames as f64 * max_ratio).ceil() as usize
}

fn stretch_latency_frames(stretch: &Stretch, ratio: f64) -> u64 {
    let ratio = sanitize_ratio(ratio);
    (stretch.input_latency() as f64 / ratio + stretch.output_latency() as f64)
        .round()
        .max(0.0) as u64
}

fn sample_interpolated(
    track: &DecodedTrack,
    base_frame: usize,
    frac: f32,
    out_channel: usize,
) -> f32 {
    let channels = track.channels.max(1);
    let ch = out_channel.min(channels - 1);
    let idx0 = base_frame * channels + ch;
    let idx1 = idx0 + channels;
    let a = track.samples.get(idx0).copied().unwrap_or(0.0);
    let b = track.samples.get(idx1).copied().unwrap_or(a);
    a + (b - a) * frac
}

fn sample_interpolated_at_source(track: &DecodedTrack, source: f64, out_channel: usize) -> f32 {
    if source < 0.0 || !source.is_finite() {
        return 0.0;
    }
    let base = source.floor() as usize;
    let frac = (source - base as f64) as f32;
    sample_interpolated(track, base, frac, out_channel)
}
