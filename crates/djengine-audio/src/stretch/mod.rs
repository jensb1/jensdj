pub mod signalsmith;

pub trait Stretcher {
    fn feed(&mut self, input: &[f32]);
    fn pull(&mut self, output: &mut [f32]) -> usize;
    fn set_ratio(&mut self, ratio: f64);
    fn reset(&mut self);
}

pub use signalsmith::SignalsmithStretcher;
