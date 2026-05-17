pub mod cpal;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameInfo {
    pub global_frame: u64,
    pub sample_rate: u32,
    pub channels: usize,
}

pub trait Backend {
    type Stream;

    fn start<F>(&self, callback: F) -> anyhow::Result<Self::Stream>
    where
        F: FnMut(&mut [f32], FrameInfo) + Send + 'static;
}

pub use cpal::CpalBackend;
