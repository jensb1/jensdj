use std::{fs::File, path::Path};

use anyhow::{anyhow, Context, Result};
use symphonia::core::{
    codecs::audio::AudioDecoderOptions,
    errors::Error as SymphoniaError,
    formats::{probe::Hint, FormatOptions, TrackType},
    io::MediaSourceStream,
    meta::MetadataOptions,
    meta::{RawValue, StandardTag, Tag},
};

const MIN_NORMALIZED_BPM: f32 = 60.0;
const MAX_NORMALIZED_BPM: f32 = 200.0;
const MIN_BEAT_INTERVAL_SECONDS: f32 = 0.20;
const MAX_BEAT_INTERVAL_SECONDS: f32 = 2.50;
const REGULAR_TRANSIENT_RELATIVE_MAD: f32 = 0.03;
const ENERGY_RATE_HZ: f64 = 500.0;
const GRID_LOW_PASS_HZ: f32 = 250.0;
const TRANSIENT_LOW_PASS_HZ: f32 = 200.0;

pub fn detect_bpm(path: impl AsRef<Path>) -> Result<f32> {
    let path = path.as_ref();
    let bpm_hint = read_bpm_tag(path).ok().flatten();
    let (samples, sample_rate) = decode_file_to_mono(path)?;

    estimate_beat_grid_from_mono_with_hint(&samples, sample_rate, bpm_hint)
        .map(|(bpm, _)| bpm)
        .ok_or_else(|| anyhow!("could not estimate bpm from {}", path.display()))
}

pub fn read_bpm_tag(path: impl AsRef<Path>) -> Result<Option<f32>> {
    let path = path.as_ref();
    let file =
        Box::new(File::open(path).with_context(|| format!("failed to open {}", path.display()))?);
    let media_source = MediaSourceStream::new(file, Default::default());

    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }

    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            media_source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .with_context(|| format!("failed to probe {}", path.display()))?;

    let mut metadata = format.metadata();
    let Some(revision) = metadata.skip_to_latest() else {
        return Ok(None);
    };

    Ok(revision.media.tags.iter().find_map(parse_bpm_tag))
}

pub fn estimate_bpm_from_mono(samples: &[f32], sample_rate: u32) -> Option<f32> {
    estimate_beat_grid_from_mono(samples, sample_rate).map(|(bpm, _)| bpm)
}

pub(crate) fn estimate_beat_grid_from_mono(
    samples: &[f32],
    sample_rate: u32,
) -> Option<(f32, Vec<f32>)> {
    estimate_beat_grid_from_mono_with_hint(samples, sample_rate, None)
}

pub(crate) fn estimate_beat_grid_from_mono_with_hint(
    samples: &[f32],
    sample_rate: u32,
    bpm_hint: Option<f32>,
) -> Option<(f32, Vec<f32>)> {
    if sample_rate == 0 || samples.is_empty() || peak_amplitude(samples) <= f32::EPSILON {
        return None;
    }

    let transients = detect_transient_indices(samples, sample_rate);
    let transient_bpm = estimate_bpm_from_transients(&transients, sample_rate);
    let transient_beats = indices_to_seconds(&transients, sample_rate);
    let duration_seconds = samples.len() as f32 / sample_rate as f32;
    let tracked = track_beats_with_aubio(samples, sample_rate);

    if transient_bpm.is_some() && transient_grid_is_regular(&transients, sample_rate) {
        return transient_bpm.map(|bpm| {
            let beats = if transient_grid_matches_bpm(&transients, sample_rate, bpm) {
                transient_beats
            } else {
                regular_grid_from_reference(&transient_beats, bpm, duration_seconds)
            };
            (bpm, beats)
        });
    }

    if let Some((bpm, beats)) = estimate_scored_beat_grid(
        samples,
        sample_rate,
        bpm_hint,
        transient_bpm,
        tracked.as_ref().map(|(bpm, _)| *bpm),
    ) {
        return Some((bpm, beats));
    }

    if let Some((bpm, beats)) = tracked {
        return Some((
            bpm,
            regular_grid_from_reference(&beats, bpm, duration_seconds),
        ));
    }

    transient_bpm.map(|bpm| (bpm, transient_beats))
}

pub(crate) fn detect_transient_indices(samples: &[f32], sample_rate: u32) -> Vec<usize> {
    if sample_rate == 0 || samples.is_empty() {
        return Vec::new();
    }

    let peak = peak_amplitude(samples);

    if peak <= f32::EPSILON {
        return Vec::new();
    }

    let mean_abs = samples
        .iter()
        .copied()
        .filter(|sample| sample.is_finite())
        .map(f32::abs)
        .sum::<f32>()
        / samples.len() as f32;

    let threshold = (peak * 0.30).max(mean_abs * 6.0).min(peak * 0.80);
    let min_distance = ((sample_rate as f32 * 0.20).round() as usize).max(1);

    let mut transients = Vec::new();
    let mut candidate: Option<(usize, f32)> = None;
    let mut window_end = 0usize;

    for (index, amplitude) in samples
        .iter()
        .copied()
        .map(|sample| sample.abs())
        .enumerate()
    {
        if !amplitude.is_finite() || amplitude < threshold {
            continue;
        }

        match candidate {
            Some((candidate_index, candidate_amplitude)) if index <= window_end => {
                if amplitude > candidate_amplitude {
                    candidate = Some((index, amplitude));
                    window_end = index.saturating_add(min_distance);
                } else {
                    candidate = Some((candidate_index, candidate_amplitude));
                }
            }
            Some((candidate_index, _)) => {
                transients.push(candidate_index);
                candidate = Some((index, amplitude));
                window_end = index.saturating_add(min_distance);
            }
            None => {
                candidate = Some((index, amplitude));
                window_end = index.saturating_add(min_distance);
            }
        }
    }

    if let Some((candidate_index, _)) = candidate {
        transients.push(candidate_index);
    }

    transients
}

fn peak_amplitude(samples: &[f32]) -> f32 {
    samples
        .iter()
        .copied()
        .filter(|sample| sample.is_finite())
        .map(f32::abs)
        .fold(0.0, f32::max)
}

pub(crate) fn estimate_bpm_from_transients(transients: &[usize], sample_rate: u32) -> Option<f32> {
    if sample_rate == 0 || transients.len() < 2 {
        return None;
    }

    let mut intervals = transients
        .windows(2)
        .filter_map(|pair| pair[1].checked_sub(pair[0]))
        .map(|interval| interval as f32 / sample_rate as f32)
        .filter(|seconds| (MIN_BEAT_INTERVAL_SECONDS..=MAX_BEAT_INTERVAL_SECONDS).contains(seconds))
        .collect::<Vec<_>>();

    if intervals.is_empty() {
        return None;
    }

    intervals.sort_by(|left, right| left.total_cmp(right));
    let median = intervals[intervals.len() / 2];
    let bpm = normalize_bpm(60.0 / median);

    bpm.is_finite().then_some(bpm)
}

fn parse_bpm_tag(tag: &Tag) -> Option<f32> {
    if let Some(StandardTag::Bpm(bpm)) = tag.std.as_ref() {
        return sanitize_bpm(*bpm as f32);
    }

    let key = tag.raw.key.to_ascii_lowercase();
    if matches!(key.as_str(), "tbpm" | "bpm" | "tempo") {
        return parse_bpm_value(&tag.raw.value).and_then(sanitize_bpm);
    }

    None
}

fn parse_bpm_value(value: &RawValue) -> Option<f32> {
    match value {
        RawValue::Float(value) => Some(*value as f32),
        RawValue::SignedInt(value) => Some(*value as f32),
        RawValue::UnsignedInt(value) => Some(*value as f32),
        RawValue::String(value) => parse_bpm_string(value),
        RawValue::StringList(values) => values.iter().find_map(|value| parse_bpm_string(value)),
        RawValue::Binary(_) | RawValue::Boolean(_) | RawValue::Flag => None,
        _ => None,
    }
}

fn parse_bpm_string(value: &str) -> Option<f32> {
    value
        .split(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .find_map(|part| {
            (!part.is_empty())
                .then(|| part.parse::<f32>().ok())
                .flatten()
        })
}

fn sanitize_bpm(bpm: f32) -> Option<f32> {
    (bpm.is_finite() && (20.0..=300.0).contains(&bpm)).then_some(normalize_bpm(bpm))
}

fn indices_to_seconds(indices: &[usize], sample_rate: u32) -> Vec<f32> {
    indices
        .iter()
        .map(|index| *index as f32 / sample_rate as f32)
        .collect()
}

fn transient_grid_is_regular(transients: &[usize], sample_rate: u32) -> bool {
    let mut intervals = beat_intervals_from_indices(transients, sample_rate);
    if intervals.len() < 4 {
        return false;
    }

    let median_interval = median(&mut intervals);
    if median_interval <= f32::EPSILON {
        return false;
    }

    let mut deviations = intervals
        .into_iter()
        .map(|interval| (interval - median_interval).abs())
        .collect::<Vec<_>>();
    let mad = median(&mut deviations);
    mad / median_interval <= REGULAR_TRANSIENT_RELATIVE_MAD
}

fn beat_intervals_from_indices(transients: &[usize], sample_rate: u32) -> Vec<f32> {
    transients
        .windows(2)
        .filter_map(|pair| pair[1].checked_sub(pair[0]))
        .map(|interval| interval as f32 / sample_rate as f32)
        .filter(|seconds| (MIN_BEAT_INTERVAL_SECONDS..=MAX_BEAT_INTERVAL_SECONDS).contains(seconds))
        .collect()
}

fn transient_grid_matches_bpm(transients: &[usize], sample_rate: u32, bpm: f32) -> bool {
    let mut intervals = beat_intervals_from_indices(transients, sample_rate);
    if intervals.is_empty() {
        return false;
    }

    let detected_interval = median(&mut intervals);
    let bpm_interval = 60.0 / bpm;
    bpm_interval.is_finite()
        && bpm_interval > f32::EPSILON
        && ((detected_interval - bpm_interval).abs() / bpm_interval) <= 0.01
}

fn bpm_from_beat_seconds(beats: &[f32]) -> Option<f32> {
    if beats.len() < 2 {
        return None;
    }

    let mut intervals = beats
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .filter(|seconds| (MIN_BEAT_INTERVAL_SECONDS..=MAX_BEAT_INTERVAL_SECONDS).contains(seconds))
        .collect::<Vec<_>>();
    if intervals.is_empty() {
        return None;
    }

    let beat_duration = median(&mut intervals);
    sanitize_bpm(60.0 / beat_duration)
}

fn median(values: &mut [f32]) -> f32 {
    values.sort_by(|left, right| left.total_cmp(right));
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        (values[middle - 1] + values[middle]) * 0.5
    } else {
        values[middle]
    }
}

fn track_beats_with_aubio(samples: &[f32], sample_rate: u32) -> Option<(f32, Vec<f32>)> {
    if sample_rate == 0 || samples.len() < sample_rate as usize {
        return None;
    }

    let hop_size = 512;
    let buffer_size = 1024;
    let mut tempo = aubio_rs::Tempo::new(
        aubio_rs::OnsetMode::SpecFlux,
        buffer_size,
        hop_size,
        sample_rate,
    )
    .ok()?;

    tempo.set_silence(-70.0);
    tempo.set_threshold(0.2);

    let mut frame = vec![0.0 as aubio_rs::Smpl; hop_size];
    let mut beats = Vec::new();

    for chunk in samples.chunks(hop_size) {
        frame.fill(0.0);

        for (target, sample) in frame.iter_mut().zip(chunk.iter().copied()) {
            *target = sample as aubio_rs::Smpl;
        }

        let detected = tempo.do_result(&frame).ok()?;
        if detected <= 0.0 {
            continue;
        }

        let beat_seconds = tempo.get_last_s();
        if !beat_seconds.is_finite() || beat_seconds < 0.0 {
            continue;
        }

        let is_unique = beats
            .last()
            .map(|last| beat_seconds - *last > 0.1)
            .unwrap_or(true);
        if is_unique {
            beats.push(beat_seconds);
        }
    }

    let bpm = bpm_from_beat_seconds(&beats).or_else(|| sanitize_bpm(tempo.get_bpm()))?;
    (beats.len() >= 4).then_some((bpm, beats))
}

fn bpm_from_hint_and_measurement(hint: f32, measured: Option<f32>) -> Option<f32> {
    let Some(measured) = measured.and_then(sanitize_bpm) else {
        return Some(hint);
    };

    let ratios = [0.25, 0.5, 1.0, 2.0, 4.0];
    ratios
        .iter()
        .filter_map(|ratio| sanitize_bpm(measured * ratio))
        .map(|candidate| (((candidate - hint).abs() / hint), candidate))
        .filter(|(error, _)| *error <= 0.03)
        .min_by(|left, right| left.0.total_cmp(&right.0))
        .map(|(_, candidate)| candidate)
}

#[derive(Clone, Copy, Debug)]
struct ScoredGrid {
    bpm: f32,
    interval: f64,
    phase: f64,
    score: f64,
}

#[derive(Clone, Copy, Debug)]
struct LowPass {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl LowPass {
    fn new(cutoff_hz: f32, sample_rate: u32) -> Self {
        let sample_rate = sample_rate.max(1) as f64;
        let w0 = 2.0 * std::f64::consts::PI * f64::from(cutoff_hz) / sample_rate;
        let cosw0 = w0.cos() as f32;
        let sinw0 = w0.sin() as f32;
        let alpha = sinw0 / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let a0 = 1.0 + alpha;
        let b0 = ((1.0 - cosw0) * 0.5) / a0;
        let b1 = (1.0 - cosw0) / a0;
        let b2 = b0;
        let a1 = (-2.0 * cosw0) / a0;
        let a2 = (1.0 - alpha) / a0;
        Self {
            b0,
            b1,
            b2,
            a1,
            a2,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        let y = self.b0 * sample + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = sample;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

fn estimate_scored_beat_grid(
    samples: &[f32],
    sample_rate: u32,
    bpm_hint: Option<f32>,
    transient_bpm: Option<f32>,
    tracked_bpm: Option<f32>,
) -> Option<(f32, Vec<f32>)> {
    let duration_seconds = samples.len() as f64 / f64::from(sample_rate.max(1));
    if duration_seconds <= 0.0 {
        return None;
    }

    let mut rough_bpms = Vec::new();
    let hint = bpm_hint.and_then(sanitize_bpm);
    if let Some(hint) = hint {
        rough_bpms.push(hint);
        if let Some(measured) = bpm_from_hint_and_measurement(hint, tracked_bpm.or(transient_bpm)) {
            rough_bpms.push(measured);
        }
    }
    for bpm in [
        low_pass_transient_bpm(samples, sample_rate),
        tracked_bpm.and_then(sanitize_bpm),
        transient_bpm.and_then(sanitize_bpm),
    ]
    .into_iter()
    .flatten()
    {
        rough_bpms.push(bpm);
    }

    let mut unique_bpms = Vec::new();
    for bpm in rough_bpms {
        if !unique_bpms
            .iter()
            .any(|existing| relative_bpm_error(*existing, bpm) <= 0.002)
        {
            unique_bpms.push(bpm);
        }
    }

    if unique_bpms.is_empty() {
        return None;
    }

    let (energy, filtered) = onset_energy(samples, sample_rate)?;
    let mut best: Option<ScoredGrid> = None;
    for rough_bpm in unique_bpms {
        let candidate = scan_grid(&energy, duration_seconds, rough_bpm)?;
        best = match best {
            Some(current) if current.score >= candidate.score => Some(current),
            _ => Some(candidate),
        };
    }

    let mut grid = best?;
    correct_grid_drift(&mut grid, &filtered, sample_rate, duration_seconds);
    Some((
        grid.bpm,
        grid_from_phase(grid.phase, grid.interval, duration_seconds),
    ))
}

fn relative_bpm_error(left: f32, right: f32) -> f32 {
    let denominator = left.abs().max(right.abs()).max(f32::EPSILON);
    (left - right).abs() / denominator
}

fn low_pass_transient_bpm(samples: &[f32], sample_rate: u32) -> Option<f32> {
    let transient_times = low_pass_transient_times(samples, sample_rate);
    estimate_bpm_from_times(&transient_times)
}

fn low_pass_transient_times(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if sample_rate == 0 || samples.is_empty() {
        return Vec::new();
    }

    let mut low_1 = LowPass::new(TRANSIENT_LOW_PASS_HZ, sample_rate);
    let mut low_2 = LowPass::new(TRANSIENT_LOW_PASS_HZ, sample_rate);
    let mut times = Vec::new();
    let mut last_time = -1.0f32;
    let mut in_transient = false;
    let mut envelope = 0.0f32;
    let peak = peak_amplitude(samples);
    let threshold = (peak * 0.02).clamp(0.005, 0.02);
    let min_interval = 0.2f32;
    let attack = 0.005f32;
    let release = 0.0005f32;

    for (index, &sample) in samples.iter().enumerate() {
        let filtered = low_2.process(low_1.process(sample));
        let sample = filtered.abs();
        if sample > envelope {
            envelope += attack * (sample - envelope);
        } else {
            envelope += release * (sample - envelope);
        }

        let time = index as f32 / sample_rate as f32;
        if !in_transient && envelope > threshold {
            if last_time < 0.0 || time - last_time > min_interval {
                times.push(time);
                last_time = time;
            }
            in_transient = true;
        } else if in_transient && envelope < threshold * 0.5 {
            in_transient = false;
        }
    }

    times
}

fn estimate_bpm_from_times(times: &[f32]) -> Option<f32> {
    if times.len() < 3 {
        return None;
    }

    let mut intervals = times
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .filter(|interval| (0.3..=1.0).contains(interval))
        .collect::<Vec<_>>();
    if intervals.len() < 2 {
        return None;
    }

    let median_interval = median(&mut intervals);
    let mut close_sum = 0.0f64;
    let mut close_count = 0usize;
    for interval in intervals {
        if (interval - median_interval).abs() < 0.001 {
            close_sum += f64::from(interval);
            close_count += 1;
        }
    }
    let interval = if close_count > 0 {
        (close_sum / close_count as f64) as f32
    } else {
        median_interval
    };

    sanitize_bpm(60.0 / interval)
}

fn onset_energy(samples: &[f32], sample_rate: u32) -> Option<(Vec<f32>, Vec<f32>)> {
    if sample_rate == 0 || samples.is_empty() {
        return None;
    }

    let energy_window = ((f64::from(sample_rate) / ENERGY_RATE_HZ).round() as usize).max(1);
    let n_energy = samples.len() / energy_window;
    if n_energy < 10 {
        return None;
    }

    let mut low_1 = LowPass::new(GRID_LOW_PASS_HZ, sample_rate);
    let mut low_2 = LowPass::new(GRID_LOW_PASS_HZ, sample_rate);
    let mut raw_energy = vec![0.0f32; n_energy];
    let mut filtered = Vec::with_capacity(samples.len());

    for (index, &sample) in samples.iter().enumerate() {
        let filtered_sample = low_2.process(low_1.process(sample));
        filtered.push(filtered_sample);
        let bin = index / energy_window;
        if bin < n_energy {
            raw_energy[bin] += filtered_sample * filtered_sample;
        }
    }

    let mut energy = vec![0.0f32; n_energy];
    for index in 1..n_energy {
        energy[index] = (raw_energy[index] - raw_energy[index - 1]).max(0.0);
    }
    Some((energy, filtered))
}

fn scan_grid(energy: &[f32], duration_seconds: f64, rough_bpm: f32) -> Option<ScoredGrid> {
    let rough_bpm = sanitize_bpm(rough_bpm)?;
    let mut best = ScoredGrid {
        bpm: rough_bpm,
        interval: 60.0 / f64::from(rough_bpm),
        phase: 0.0,
        score: 0.0,
    };

    let mut bpm_try = f64::from(rough_bpm) - 2.0;
    while bpm_try <= f64::from(rough_bpm) + 2.0 {
        if bpm_try > 0.0 {
            let interval = 60.0 / bpm_try;
            let phase_steps = (interval * ENERGY_RATE_HZ).floor().max(1.0) as usize;
            for phase_step in 0..phase_steps {
                let phase = phase_step as f64 / ENERGY_RATE_HZ;
                let score = beat_energy(energy, duration_seconds, interval, phase);
                if score > best.score {
                    best = ScoredGrid {
                        bpm: bpm_try as f32,
                        interval,
                        phase,
                        score,
                    };
                }
            }
        }
        bpm_try += 0.05;
    }

    let coarse_bpm = f64::from(best.bpm);
    let coarse_phase = best.phase;
    best.score = 0.0;
    bpm_try = coarse_bpm - 0.5;
    while bpm_try <= coarse_bpm + 0.5 {
        if bpm_try > 0.0 {
            let interval = 60.0 / bpm_try;
            for phase_step in -10..=10 {
                let mut phase = coarse_phase + f64::from(phase_step) * 0.0005;
                while phase < 0.0 {
                    phase += interval;
                }
                while phase >= interval {
                    phase -= interval;
                }
                let score = beat_energy(energy, duration_seconds, interval, phase);
                if score > best.score {
                    best = ScoredGrid {
                        bpm: bpm_try as f32,
                        interval,
                        phase,
                        score,
                    };
                }
            }
        }
        bpm_try += 0.001;
    }

    (best.score > 0.0).then_some(best)
}

fn beat_energy(energy: &[f32], duration_seconds: f64, interval: f64, phase: f64) -> f64 {
    if energy.is_empty() || duration_seconds <= 0.0 || interval <= 0.0 {
        return 0.0;
    }

    let mut sum = 0.0f64;
    let mut time = phase;
    while time < duration_seconds {
        let center = (time / duration_seconds * energy.len() as f64).round() as isize;
        for offset in -3..=3 {
            let index = center + offset;
            if index >= 0 && (index as usize) < energy.len() {
                sum += f64::from(energy[index as usize]);
            }
        }
        time += interval;
    }
    sum
}

fn correct_grid_drift(
    grid: &mut ScoredGrid,
    filtered_samples: &[f32],
    sample_rate: u32,
    duration_seconds: f64,
) {
    if filtered_samples.is_empty() || sample_rate == 0 {
        return;
    }

    let global_max = filtered_samples
        .iter()
        .copied()
        .map(f32::abs)
        .fold(0.0, f32::max);
    if global_max <= f32::EPSILON {
        return;
    }

    let threshold = global_max * 0.3;
    let search_samples = (sample_rate / 10).max(1) as isize;

    for _ in 0..3 {
        let mut sx = 0.0f64;
        let mut sy = 0.0f64;
        let mut sxy = 0.0f64;
        let mut sx2 = 0.0f64;
        let mut count = 0usize;
        let mut beat_index = 0usize;
        let mut time = grid.phase;

        while time < duration_seconds {
            let center = (time * f64::from(sample_rate)).round() as isize;
            let mut peak_value = 0.0f32;
            let mut peak_offset = 0isize;
            for offset in -search_samples..=search_samples {
                let index = center + offset;
                if index >= 0 && (index as usize) < filtered_samples.len() {
                    let value = filtered_samples[index as usize].abs();
                    if value > peak_value {
                        peak_value = value;
                        peak_offset = offset;
                    }
                }
            }

            if peak_value > threshold {
                let x = beat_index as f64;
                let y = peak_offset as f64 / f64::from(sample_rate);
                sx += x;
                sy += y;
                sxy += x * y;
                sx2 += x * x;
                count += 1;
            }

            beat_index += 1;
            time += grid.interval;
        }

        if count < 20 {
            continue;
        }

        let n = count as f64;
        let denominator = n * sx2 - sx * sx;
        if denominator.abs() <= f64::EPSILON {
            continue;
        }

        let drift = (n * sxy - sx * sy) / denominator;
        let intercept = (sy - drift * sx) / n;
        grid.interval += drift;
        grid.phase += intercept;
        while grid.phase < 0.0 {
            grid.phase += grid.interval;
        }
        while grid.phase >= grid.interval {
            grid.phase -= grid.interval;
        }
        grid.bpm = (60.0 / grid.interval) as f32;
    }
}

fn grid_from_phase(phase: f64, interval: f64, duration_seconds: f64) -> Vec<f32> {
    if !phase.is_finite()
        || !interval.is_finite()
        || !duration_seconds.is_finite()
        || interval <= f64::EPSILON
    {
        return Vec::new();
    }

    let mut beats = Vec::new();
    let mut time = phase;
    while time < duration_seconds {
        beats.push(time as f32);
        time += interval;
    }
    beats
}

fn regular_grid_from_reference(reference: &[f32], bpm: f32, duration_seconds: f32) -> Vec<f32> {
    let Some(anchor) = reference.iter().copied().find(|beat| beat.is_finite()) else {
        return Vec::new();
    };
    let interval = 60.0 / bpm;
    if !interval.is_finite() || interval <= f32::EPSILON {
        return Vec::new();
    }

    let mut first = anchor;
    while first - interval >= 0.0 {
        first -= interval;
    }

    let mut beats = Vec::new();
    let mut beat = first;
    let end = duration_seconds + interval;
    while beat <= end {
        beats.push(beat.max(0.0));
        beat += interval;
    }
    beats
}

pub(crate) fn normalize_bpm(mut bpm: f32) -> f32 {
    if !bpm.is_finite() || bpm <= 0.0 {
        return bpm;
    }

    while bpm < MIN_NORMALIZED_BPM {
        bpm *= 2.0;
    }

    while bpm > MAX_NORMALIZED_BPM {
        bpm *= 0.5;
    }

    bpm
}

fn decode_file_to_mono(path: &Path) -> Result<(Vec<f32>, u32)> {
    let file =
        Box::new(File::open(path).with_context(|| format!("failed to open {}", path.display()))?);
    let media_source = MediaSourceStream::new(file, Default::default());

    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }

    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            media_source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .with_context(|| format!("failed to probe {}", path.display()))?;

    let (track_id, codec_params) = {
        let track = format
            .default_track(TrackType::Audio)
            .ok_or_else(|| anyhow!("no audio track in {}", path.display()))?;
        let codec_params = track
            .codec_params
            .as_ref()
            .and_then(|params| params.audio())
            .ok_or_else(|| anyhow!("missing audio codec parameters in {}", path.display()))?
            .clone();

        (track.id, codec_params)
    };

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .context("failed to create audio decoder")?;

    let mut samples = Vec::new();
    let mut sample_rate = codec_params.sample_rate;

    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => return Err(anyhow!("failed to read audio packet: {error}")),
        };

        if packet.track_id != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(error) => return Err(anyhow!("failed to decode audio packet: {error}")),
        };

        sample_rate = Some(decoded.spec().rate());
        let channel_count = decoded.spec().channels().count().max(1);
        let mut interleaved = vec![0.0; decoded.samples_interleaved()];
        decoded.copy_to_slice_interleaved(&mut interleaved);

        for frame in interleaved.chunks(channel_count) {
            samples.push(frame.iter().copied().sum::<f32>() / frame.len() as f32);
        }
    }

    let sample_rate =
        sample_rate.ok_or_else(|| anyhow!("missing sample rate in {}", path.display()))?;

    if samples.is_empty() {
        return Err(anyhow!("no decoded audio samples in {}", path.display()));
    }

    Ok((samples, sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_RATE: u32 = 48_000;

    #[test]
    fn estimates_bpm_for_generated_click_tracks() {
        for bpm in [100.0, 120.0, 128.0] {
            let samples = click_track(bpm, 12.0);
            let estimated = estimate_bpm_from_mono(&samples, SAMPLE_RATE).unwrap();

            assert!(
                (estimated - bpm).abs() < 0.25,
                "expected {bpm}, got {estimated}"
            );
        }
    }

    #[test]
    fn returns_none_when_bpm_is_not_detectable() {
        let samples = vec![0.0; SAMPLE_RATE as usize * 4];

        assert_eq!(estimate_bpm_from_mono(&samples, SAMPLE_RATE), None);
    }

    #[test]
    fn bpm_hint_keeps_close_measured_tempo() {
        let selected = bpm_from_hint_and_measurement(120.0, Some(121.75)).unwrap();
        assert!((selected - 121.75).abs() < 0.001);
    }

    #[test]
    fn bpm_hint_can_select_measured_octave() {
        let selected = bpm_from_hint_and_measurement(120.0, Some(60.875)).unwrap();
        assert!((selected - 121.75).abs() < 0.001);
    }

    #[test]
    fn incompatible_bpm_hint_does_not_override_measurement() {
        assert_eq!(bpm_from_hint_and_measurement(120.0, Some(168.0)), None);
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
