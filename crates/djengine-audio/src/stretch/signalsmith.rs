use signalsmith_stretch::Stretch;

use super::Stretcher;

pub struct SignalsmithStretcher {
    inner: Stretch,
    channels: usize,
    ratio: f64,
    input: Box<[f32]>,
    input_len: usize,
    cursor: usize,
}

impl SignalsmithStretcher {
    pub fn new(channels: usize, sample_rate: u32) -> Self {
        Self {
            inner: Stretch::preset_cheaper(channels as u32, sample_rate),
            channels: channels.max(1),
            ratio: 1.0,
            input: vec![0.0; sample_rate as usize * channels.max(1)].into_boxed_slice(),
            input_len: 0,
            cursor: 0,
        }
    }
}

impl Stretcher for SignalsmithStretcher {
    fn feed(&mut self, input: &[f32]) {
        self.input_len = input.len().min(self.input.len());
        self.input[..self.input_len].copy_from_slice(&input[..self.input_len]);
        self.cursor = 0;
    }

    fn pull(&mut self, output: &mut [f32]) -> usize {
        if self.input_len == 0 || output.is_empty() {
            output.fill(0.0);
            return 0;
        }
        let output_frames = output.len() / self.channels;
        let wanted_input_frames = ((output_frames as f64 / self.ratio).ceil() as usize).max(1);
        let available_frames = self.input_len / self.channels;
        let start = self.cursor.min(available_frames);
        let end = start
            .saturating_add(wanted_input_frames)
            .min(available_frames);
        let input = &self.input[start * self.channels..end * self.channels];
        let rendered_frames = ((end - start) as f64 * self.ratio).floor() as usize;
        let rendered_samples = rendered_frames.min(output_frames) * self.channels;
        if rendered_samples == 0 {
            output.fill(0.0);
            return 0;
        }
        output[rendered_samples..].fill(0.0);
        self.inner.exact(input, &mut output[..rendered_samples]);
        self.cursor = end;
        rendered_frames
    }

    fn set_ratio(&mut self, ratio: f64) {
        self.ratio = ratio.max(f64::EPSILON);
    }

    fn reset(&mut self) {
        self.inner.reset();
        self.cursor = 0;
    }
}
