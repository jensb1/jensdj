use signalsmith_stretch::Stretch;

fn sine(frames: usize, channels: usize, sample_rate: f32) -> Vec<f32> {
    let mut samples = Vec::with_capacity(frames * channels);
    for frame in 0..frames {
        let value = (2.0 * std::f32::consts::PI * 1_000.0 * frame as f32 / sample_rate).sin();
        for _ in 0..channels {
            samples.push(value * 0.5);
        }
    }
    samples
}

fn render(input: &[f32], channels: usize, sample_rate: u32, ratio: f64) -> Vec<f32> {
    let input_frames = input.len() / channels;
    let output_frames = (input_frames as f64 * ratio).ceil() as usize;
    let mut output = vec![0.0; output_frames * channels];
    let mut stretch = Stretch::preset_cheaper(channels as u32, sample_rate);
    let _exact = stretch.exact(input, &mut output);
    output
}

fn energy(samples: &[f32]) -> f64 {
    samples
        .iter()
        .map(|sample| {
            let sample = f64::from(*sample);
            sample * sample
        })
        .sum()
}

#[test]
fn signalsmith_output_is_deterministic_for_fixed_lengths() {
    let sample_rate = 48_000;
    let channels = 2;
    let input_frames = sample_rate as usize * 10;
    let input = sine(input_frames, channels, sample_rate as f32);
    let input_mean_energy = energy(&input) / input.len() as f64;

    for ratio in [1.0, 0.5, 2.0, 1.234] {
        let first = render(&input, channels, sample_rate, ratio);
        let second = render(&input, channels, sample_rate, ratio);
        assert_eq!(first.len(), second.len());
        assert_eq!(first, second);

        let output_frames = first.len() / channels;
        let expected = (input_frames as f64 * ratio).ceil() as isize;
        assert!((output_frames as isize - expected).abs() <= 2);

        let output_mean_energy = energy(&first) / first.len() as f64;
        assert!(
            (output_mean_energy - input_mean_energy).abs() < 0.05,
            "ratio {ratio}: input mean energy {input_mean_energy}, output {output_mean_energy}"
        );
    }
}
