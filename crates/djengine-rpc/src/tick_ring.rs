use std::fs::OpenOptions;
use std::mem::size_of;
use std::path::Path;

use anyhow::{anyhow, Context};
use memmap2::{MmapMut, MmapOptions};

use djengine_audio::Tick;

const HEADER_BYTES: usize = 32;
const RECORD_BYTES: usize = 128;
const TICK_RING_VERSION: u64 = 2;

pub struct TickRing {
    mmap: MmapMut,
    capacity: usize,
}

impl TickRing {
    pub fn create(path: impl AsRef<Path>, capacity: usize) -> anyhow::Result<Self> {
        let capacity = capacity.max(1);
        let len = HEADER_BYTES + capacity * RECORD_BYTES;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path.as_ref())
            .with_context(|| format!("failed to open tick ring {}", path.as_ref().display()))?;
        file.set_len(len as u64)
            .context("failed to size tick ring file")?;
        let mut mmap = unsafe { MmapOptions::new().len(len).map_mut(&file)? };
        write_u64(&mut mmap[0..8], TICK_RING_VERSION);
        write_u64(&mut mmap[8..16], capacity as u64);
        write_u64(&mut mmap[16..24], RECORD_BYTES as u64);
        write_u64(&mut mmap[24..32], 0);
        Ok(Self { mmap, capacity })
    }

    pub fn push(&mut self, tick: Tick) -> anyhow::Result<()> {
        if self.mmap.len() < HEADER_BYTES + self.capacity * RECORD_BYTES {
            return Err(anyhow!("tick ring mmap is too small"));
        }
        let index = read_u64(&self.mmap[24..32]);
        let slot = index as usize % self.capacity;
        let offset = HEADER_BYTES + slot * RECORD_BYTES;
        encode_tick(&mut self.mmap[offset..offset + RECORD_BYTES], tick);
        write_u64(&mut self.mmap[24..32], index.wrapping_add(1));
        Ok(())
    }

    pub fn flush(&mut self) -> anyhow::Result<()> {
        self.mmap.flush().context("failed to flush tick ring")
    }
}

fn encode_tick(dst: &mut [u8], tick: Tick) {
    debug_assert!(dst.len() >= RECORD_BYTES);
    dst.fill(0);
    write_u32(&mut dst[0..4], tick.deck_id);
    write_u64(&mut dst[8..16], tick.global_frame);
    write_f64(&mut dst[16..24], tick.source_frame);
    write_f64(&mut dst[24..32], tick.position_seconds);
    write_f64(&mut dst[32..40], tick.deck_beat);
    write_f64(&mut dst[40..48], tick.deck_bar);
    write_f64(&mut dst[48..56], tick.global_master_beat);
    write_f64(&mut dst[56..64], tick.global_master_bar);
    write_f64(&mut dst[64..72], tick.global_master_bpm);
    write_f64(&mut dst[72..80], tick.loop_start_beat);
    write_f64(&mut dst[80..88], tick.loop_length_beats);
    write_f32(&mut dst[88..92], tick.volume);
    write_f64(&mut dst[96..104], tick.ratio);
    write_f64(&mut dst[104..112], tick.effective_bpm);
    dst[112] = tick.playing;
    dst[113] = tick.synced;
    dst[114] = tick.loop_active;
    write_i64(&mut dst[120..128], tick.phase_diff_samples);
}

fn read_u64(src: &[u8]) -> u64 {
    let mut bytes = [0_u8; size_of::<u64>()];
    bytes.copy_from_slice(src);
    u64::from_le_bytes(bytes)
}

fn write_u32(dst: &mut [u8], value: u32) {
    dst.copy_from_slice(&value.to_le_bytes());
}

fn write_u64(dst: &mut [u8], value: u64) {
    dst.copy_from_slice(&value.to_le_bytes());
}

fn write_i64(dst: &mut [u8], value: i64) {
    dst.copy_from_slice(&value.to_le_bytes());
}

fn write_f32(dst: &mut [u8], value: f32) {
    dst.copy_from_slice(&value.to_le_bytes());
}

fn write_f64(dst: &mut [u8], value: f64) {
    dst.copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_ring_writes_header_and_records() {
        let path = std::env::temp_dir().join(format!(
            "djengine-tick-ring-{}-{}.bin",
            std::process::id(),
            1
        ));
        let mut ring = TickRing::create(&path, 2).unwrap();
        ring.push(Tick {
            deck_id: 7,
            global_frame: 42,
            source_frame: 11.0,
            position_seconds: 0.1,
            deck_beat: 2.0,
            deck_bar: 0.5,
            global_master_beat: 2.0,
            global_master_bar: 0.5,
            global_master_bpm: 120.0,
            loop_start_beat: 0.0,
            loop_length_beats: 4.0,
            volume: 0.5,
            ratio: 1.2,
            effective_bpm: 120.0,
            playing: 1,
            synced: 1,
            loop_active: 1,
            phase_diff_samples: -3,
        })
        .unwrap();
        ring.flush().unwrap();
        drop(ring);
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(path);
        assert_eq!(read_u64(&bytes[0..8]), TICK_RING_VERSION);
        assert_eq!(read_u64(&bytes[8..16]), 2);
        assert_eq!(read_u64(&bytes[16..24]), RECORD_BYTES as u64);
        assert_eq!(read_u64(&bytes[24..32]), 1);
        assert_eq!(
            u32::from_le_bytes(bytes[HEADER_BYTES..HEADER_BYTES + 4].try_into().unwrap()),
            7
        );
    }
}
