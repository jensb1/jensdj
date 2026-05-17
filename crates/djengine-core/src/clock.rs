use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct GlobalClock {
    frames: AtomicU64,
}

impl GlobalClock {
    pub const fn new() -> Self {
        Self {
            frames: AtomicU64::new(0),
        }
    }

    pub fn load(&self) -> u64 {
        self.frames.load(Ordering::Acquire)
    }

    pub fn store(&self, frame: u64) {
        self.frames.store(frame, Ordering::Release);
    }

    pub fn advance(&self, frames: u64) -> u64 {
        self.frames.fetch_add(frames, Ordering::AcqRel) + frames
    }
}

#[cfg(test)]
mod tests {
    use super::GlobalClock;

    #[test]
    fn clock_advances_monotonically() {
        let clock = GlobalClock::new();
        assert_eq!(clock.load(), 0);
        assert_eq!(clock.advance(128), 128);
        assert_eq!(clock.advance(64), 192);
        assert_eq!(clock.load(), 192);
    }
}
