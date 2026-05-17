use std::fs::File;
use std::path::Path;

use anyhow::{bail, Context};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedAudio {
    pub sample_rate: u32,
    pub channels: usize,
    pub frames: usize,
    pub samples: Vec<f32>,
}

pub fn decode_file(path: impl AsRef<Path>) -> anyhow::Result<DecodedAudio> {
    let path = path.as_ref();
    let file = File::open(path)
        .with_context(|| format!("failed to open audio file {}", path.display()))?;

    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }

    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .with_context(|| format!("failed to probe audio file {}", path.display()))?;

    let (track_id, codec_params) = {
        let track = format
            .default_track(TrackType::Audio)
            .context("no audio track found")?;
        let codec_params = track
            .codec_params
            .as_ref()
            .and_then(|params| params.audio())
            .context("audio codec parameters missing")?
            .clone();

        (track.id, codec_params)
    };

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .context("failed to create audio decoder")?;

    let mut sample_rate = None;
    let mut channels = None;
    let mut frames = 0usize;
    let mut samples = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(Error::ResetRequired) => bail!("audio stream changed while decoding"),
            Err(error) => return Err(error).context("failed to read audio packet"),
        };

        if packet.track_id != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(Error::DecodeError(_)) | Err(Error::IoError(_)) => continue,
            Err(Error::ResetRequired) => bail!("audio decoder reset required"),
            Err(error) => return Err(error).context("failed to decode audio packet"),
        };

        let packet_rate = decoded.spec().rate();
        let packet_channels = decoded.num_planes();
        if packet_rate == 0 || packet_channels == 0 {
            bail!("decoded audio has an invalid signal specification");
        }

        match (sample_rate, channels) {
            (Some(rate), Some(channel_count))
                if rate != packet_rate || channel_count != packet_channels =>
            {
                bail!("audio signal specification changed while decoding");
            }
            (None, None) => {
                sample_rate = Some(packet_rate);
                channels = Some(packet_channels);
            }
            _ => {}
        }

        let packet_samples = decoded.samples_interleaved();
        let start = samples.len();
        let end = start
            .checked_add(packet_samples)
            .context("decoded audio sample count overflowed")?;
        samples.resize(end, 0.0);
        decoded.copy_to_slice_interleaved(&mut samples[start..]);

        frames = frames
            .checked_add(decoded.frames())
            .context("decoded audio frame count overflowed")?;
    }

    if frames == 0 {
        bail!("no audio frames decoded");
    }

    Ok(DecodedAudio {
        sample_rate: sample_rate.context("no audio sample rate decoded")?,
        channels: channels.context("no audio channel count decoded")?,
        frames,
        samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_wav_path(name: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();

        std::env::temp_dir().join(format!(
            "djengine-analysis-{name}-{}-{unique}.wav",
            std::process::id()
        ))
    }

    fn wav_bytes(sample_rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
        let bits_per_sample = 16u16;
        let block_align = channels * (bits_per_sample / 8);
        let byte_rate = sample_rate * u32::from(block_align);
        let data_len = (samples.len() * 2) as u32;
        let chunk_size = 36 + data_len;

        let mut bytes = Vec::with_capacity(44 + data_len as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&chunk_size.to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&block_align.to_le_bytes());
        bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());

        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }

        bytes
    }

    #[test]
    fn decode_decodes_synthetic_stereo_wav_to_interleaved_f32() {
        let path = temp_wav_path("stereo");
        let pcm = [0, i16::MAX, i16::MIN, 8192, -8192, 0];
        std::fs::write(&path, wav_bytes(44_100, 2, &pcm)).unwrap();

        let audio = decode_file(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert_eq!(audio.sample_rate, 44_100);
        assert_eq!(audio.channels, 2);
        assert_eq!(audio.frames, 3);
        assert_eq!(audio.samples.len(), 6);
        assert!(audio.samples[0].abs() < 0.0001);
        assert!(audio.samples[1] > 0.99);
        assert!(audio.samples[2] < -0.99);
        assert!((audio.samples[3] - 0.25).abs() < 0.01);
    }

    #[test]
    fn decode_returns_error_for_missing_file() {
        let path = temp_wav_path("missing");
        assert!(decode_file(path).is_err());
    }
}
