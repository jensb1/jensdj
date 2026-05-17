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

    if let Some(hint) = bpm_hint.and_then(sanitize_bpm) {
        let reference = tracked
            .as_ref()
            .map(|(_, beats)| beats.as_slice())
            .filter(|beats| !beats.is_empty())
            .unwrap_or(&transient_beats);
        if !reference.is_empty()
            && detected_bpm_is_compatible_with_hint(
                hint,
                tracked.as_ref().map(|(bpm, _)| *bpm).or(transient_bpm),
            )
        {
            return Some((
                hint,
                regular_grid_from_reference(reference, hint, duration_seconds),
            ));
        }
    }

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

fn detected_bpm_is_compatible_with_hint(hint: f32, detected: Option<f32>) -> bool {
    let Some(detected) = detected else {
        return true;
    };
    let ratios = [0.5, 1.0, 2.0];
    ratios.iter().any(|ratio| {
        let candidate = detected * ratio;
        ((candidate - hint).abs() / hint) <= 0.03
    })
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
