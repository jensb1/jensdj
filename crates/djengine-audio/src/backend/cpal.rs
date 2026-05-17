use anyhow::{anyhow, Context};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::{Backend, FrameInfo};

#[derive(Debug, Clone, Copy, Default)]
pub struct CpalBackend;

impl CpalBackend {
    pub fn default_output_info() -> anyhow::Result<(u32, usize)> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| anyhow!("no default output device"))?;
        let supported = device
            .default_output_config()
            .context("failed to get default output config")?;
        Ok((
            supported.config().sample_rate,
            usize::from(supported.config().channels),
        ))
    }
}

impl Backend for CpalBackend {
    type Stream = cpal::Stream;

    fn start<F>(&self, mut callback: F) -> anyhow::Result<Self::Stream>
    where
        F: FnMut(&mut [f32], FrameInfo) + Send + 'static,
    {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| anyhow!("no default output device"))?;
        let supported = device
            .default_output_config()
            .context("failed to get default output config")?;
        if supported.sample_format() != cpal::SampleFormat::F32 {
            return Err(anyhow!(
                "default output format is {format}; only f32 is supported by this backend wrapper",
                format = supported.sample_format()
            ));
        }

        let config: cpal::StreamConfig = supported.config();
        let channels = usize::from(config.channels);
        let sample_rate = config.sample_rate;
        let mut global_frame = 0_u64;
        let err_fn = |_err| {};
        let stream = device.build_output_stream(
            &config,
            move |output: &mut [f32], _| {
                let start = global_frame;
                callback(
                    output,
                    FrameInfo {
                        global_frame: start,
                        sample_rate,
                        channels,
                    },
                );
                global_frame = global_frame.saturating_add((output.len() / channels) as u64);
            },
            err_fn,
            None,
        )?;
        stream.play()?;
        Ok(stream)
    }
}
