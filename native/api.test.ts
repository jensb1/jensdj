/**
 * api.test.ts — Tests for getter/setter roundtrips, device enumeration,
 * analysis (peaks, 3band, BPM), level metering, loop state, diagnostics.
 *
 * Uses direct FFI (dlopen) — no RPC/AudioEngine layer.
 * Test assets: test-assets/beat100.mp3, beat120.mp3, beat125.mp3
 */
import { beforeAll, afterAll, describe, test, expect, setDefaultTimeout } from "bun:test";
import { dlopen, FFIType, ptr, CString, type Pointer } from "bun:ffi";
import { resolve } from "path";
import { existsSync } from "fs";

setDefaultTimeout(30000);

const ASSETS = resolve(import.meta.dir, "../test-assets");
const BEAT_100 = resolve(ASSETS, "beat100.mp3");
const BEAT_120 = resolve(ASSETS, "beat120.mp3");

const assetsExist = existsSync(BEAT_100) && existsSync(BEAT_120);
const testIfAssets = assetsExist ? test : test.skip;

function cstr(s: string): Uint8Array {
  return new TextEncoder().encode(s + "\0");
}

function floatBuf(count: number): { buffer: Float32Array; pointer: Pointer } {
  const buffer = new Float32Array(count);
  return { buffer, pointer: ptr(buffer) as Pointer };
}

const LIB_PATH = resolve(import.meta.dir, "libdjengine.dylib");
let lib: ReturnType<typeof dlopen>;
let s: typeof lib.symbols;

beforeAll(async () => {
  await Bun.$`cd native && zig build`.quiet();

  lib = dlopen(LIB_PATH, {
    dj_init: { returns: FFIType.i32 },
    dj_shutdown: { returns: FFIType.void },
    dj_get_device_count: { returns: FFIType.i32 },
    dj_get_device_name: { args: [FFIType.i32], returns: FFIType.ptr },
    dj_get_device_channels: { args: [FFIType.i32], returns: FFIType.i32 },
    dj_create_engine: { args: [FFIType.i32], returns: FFIType.ptr },
    dj_destroy_engine: { args: [FFIType.ptr], returns: FFIType.void },
    dj_load_sound: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
    dj_unload_sound: { args: [FFIType.ptr], returns: FFIType.void },
    dj_play: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_pause: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_stop: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_seek: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.i32 },
    dj_get_position: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_get_duration: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_is_playing: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_set_volume: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_set_eq: { args: [FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.f32], returns: FFIType.void },
    dj_get_eq_lo: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_get_eq_mid: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_get_eq_hi: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_set_filter: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_get_filter: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_set_loop: { args: [FFIType.ptr, FFIType.f32, FFIType.f32], returns: FFIType.void },
    dj_clear_loop: { args: [FFIType.ptr], returns: FFIType.void },
    dj_is_looping: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_set_beat_ref: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_get_beat_ref: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_get_level: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_get_rb_latency: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_get_rb_available: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_pull_frames: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    dj_get_sample_rate: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_get_peaks: { args: [FFIType.cstring, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    dj_get_peaks_3band: { args: [FFIType.cstring, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    dj_detect_bpm: { args: [FFIType.cstring], returns: FFIType.f32 },
    dj_zig_version: { returns: FFIType.i32 },
  });
  s = lib.symbols;
  s.dj_init();
});

afterAll(() => {
  s?.dj_shutdown();
  setTimeout(() => process.exit(0), 100);
});

// --- Device Enumeration ---

describe("device enumeration", () => {
  test("dj_get_device_count returns at least 1 device", () => {
    const count = s.dj_get_device_count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("dj_get_device_name returns non-empty string for valid index", () => {
    const count = s.dj_get_device_count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const namePtr = s.dj_get_device_name(i);
      expect(namePtr).not.toBe(null);
      const name = new CString(namePtr as number);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("dj_get_device_channels returns > 0 for valid index", () => {
    const count = s.dj_get_device_count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const channels = s.dj_get_device_channels(i);
      expect(channels).toBeGreaterThanOrEqual(1);
    }
  });

  test("dj_get_device_name returns empty for out-of-range index", () => {
    const namePtr = s.dj_get_device_name(-1);
    const name = new CString(namePtr as number);
    expect(name.length).toBe(0);
  });

  test("dj_get_device_channels returns 0 for out-of-range index", () => {
    expect(s.dj_get_device_channels(-1)).toBe(0);
    expect(s.dj_get_device_channels(999)).toBe(0);
  });
});

// --- EQ Getter/Setter Roundtrip ---

describe("EQ getters", () => {
  testIfAssets("set/get EQ roundtrip", () => {
    const engine = s.dj_create_engine(-1);
    expect(engine).not.toBe(null);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    s.dj_set_eq(sound!, 0.5, 1.2, 0.8);
    expect(s.dj_get_eq_lo(sound!)).toBeCloseTo(0.5, 2);
    expect(s.dj_get_eq_mid(sound!)).toBeCloseTo(1.2, 2);
    expect(s.dj_get_eq_hi(sound!)).toBeCloseTo(0.8, 2);

    // Update and verify again
    s.dj_set_eq(sound!, 0.0, 0.0, 0.0);
    expect(s.dj_get_eq_lo(sound!)).toBeCloseTo(0.0, 2);
    expect(s.dj_get_eq_mid(sound!)).toBeCloseTo(0.0, 2);
    expect(s.dj_get_eq_hi(sound!)).toBeCloseTo(0.0, 2);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Filter Getter/Setter Roundtrip ---

describe("filter getters", () => {
  testIfAssets("set/get filter roundtrip", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    // LP range (0.0 = full LP)
    s.dj_set_filter(sound!, 0.2);
    expect(s.dj_get_filter(sound!)).toBeCloseTo(0.2, 2);

    // HP range (1.0 = full HP)
    s.dj_set_filter(sound!, 0.9);
    expect(s.dj_get_filter(sound!)).toBeCloseTo(0.9, 2);

    // Bypass (0.5 = bypass)
    s.dj_set_filter(sound!, 0.5);
    expect(s.dj_get_filter(sound!)).toBeCloseTo(0.5, 2);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Loop State ---

describe("loop state", () => {
  testIfAssets("set_loop / is_looping / clear_loop roundtrip", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    // Initially not looping
    expect(s.dj_is_looping(sound!)).toBe(0);

    // Set loop and verify
    s.dj_set_loop(sound!, 1.0, 3.0);
    expect(s.dj_is_looping(sound!)).toBe(1);

    // Clear loop
    s.dj_clear_loop(sound!);
    expect(s.dj_is_looping(sound!)).toBe(0);

    // Re-set and verify again
    s.dj_set_loop(sound!, 2.0, 4.0);
    expect(s.dj_is_looping(sound!)).toBe(1);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Beat Ref ---

describe("beat ref", () => {
  testIfAssets("set/get beat_ref roundtrip", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    s.dj_set_beat_ref(sound!, 1.234);
    expect(s.dj_get_beat_ref(sound!)).toBeCloseTo(1.234, 2);

    s.dj_set_beat_ref(sound!, 0.0);
    expect(s.dj_get_beat_ref(sound!)).toBeCloseTo(0.0, 2);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Level Metering ---

describe("level metering", () => {
  testIfAssets("dj_get_level returns > 0 after pulling frames", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    s.dj_set_volume(sound!, 1.0);
    s.dj_play(sound!);

    // Pull frames to populate RMS accumulators
    const { pointer: pullBuf } = floatBuf(2048);
    s.dj_pull_frames(sound!, pullBuf, 1024);

    const level = s.dj_get_level(sound!);
    expect(level).toBeGreaterThan(0);

    s.dj_stop(sound!);
    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });

  testIfAssets("dj_get_level returns 0 when not playing", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    const level = s.dj_get_level(sound!);
    expect(level).toBe(0);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Diagnostics ---

describe("diagnostics", () => {
  testIfAssets("rb_latency and rb_available return valid values", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    const latency = s.dj_get_rb_latency(sound!);
    expect(latency).toBeGreaterThanOrEqual(0);

    // Pull some frames to populate RubberBand buffer
    const { pointer: pullBuf } = floatBuf(2048);
    s.dj_pull_frames(sound!, pullBuf, 512);

    const available = s.dj_get_rb_available(sound!);
    expect(available).toBeGreaterThanOrEqual(0);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Analysis: Peaks ---

describe("analysis", () => {
  testIfAssets("dj_get_peaks extracts waveform peaks", () => {
    const numPoints = 200;
    const { buffer, pointer } = floatBuf(numPoints);
    const result = s.dj_get_peaks(cstr(BEAT_100), pointer, numPoints);
    expect(result).toBe(0); // success

    // Peaks should have non-zero values (audio has content)
    let maxPeak = 0;
    for (let i = 0; i < numPoints; i++) {
      if (buffer[i]! > maxPeak) maxPeak = buffer[i]!;
    }
    expect(maxPeak).toBeGreaterThan(0);
    // All peaks should be in [0, 1] range
    for (let i = 0; i < numPoints; i++) {
      expect(buffer[i]!).toBeGreaterThanOrEqual(0);
      expect(buffer[i]!).toBeLessThanOrEqual(1.0);
    }
  });

  testIfAssets("dj_get_peaks_3band extracts 3-band peaks", () => {
    const numPoints = 200;
    const { buffer, pointer } = floatBuf(numPoints * 3);
    const result = s.dj_get_peaks_3band(cstr(BEAT_100), pointer, numPoints);
    expect(result).toBe(0); // success

    // Check that all three bands have data
    let maxLo = 0, maxMid = 0, maxHi = 0;
    for (let i = 0; i < numPoints; i++) {
      const lo = buffer[i * 3]!;
      const mid = buffer[i * 3 + 1]!;
      const hi = buffer[i * 3 + 2]!;
      if (lo > maxLo) maxLo = lo;
      if (mid > maxMid) maxMid = mid;
      if (hi > maxHi) maxHi = hi;
    }
    // Beat tracks have energy across bands
    expect(maxLo).toBeGreaterThan(0);
    expect(maxMid).toBeGreaterThan(0);
    expect(maxHi).toBeGreaterThan(0);
  });

  testIfAssets("dj_detect_bpm returns reasonable BPM for beat100", () => {
    const bpm = s.dj_detect_bpm(cstr(BEAT_100));
    // beat100.mp3 is 100 BPM
    expect(bpm).toBeGreaterThan(95);
    expect(bpm).toBeLessThan(105);
  });

  testIfAssets("dj_detect_bpm returns reasonable BPM for beat120", () => {
    const bpm = s.dj_detect_bpm(cstr(BEAT_120));
    // beat120.mp3 is 120 BPM
    expect(bpm).toBeGreaterThan(115);
    expect(bpm).toBeLessThan(125);
  });

  test("dj_get_peaks returns error for nonexistent file", () => {
    const { pointer } = floatBuf(100);
    const result = s.dj_get_peaks(cstr("/nonexistent/file.mp3"), pointer, 100);
    expect(result).not.toBe(0);
  });

  test("dj_detect_bpm returns 0 for nonexistent file", () => {
    const bpm = s.dj_detect_bpm(cstr("/nonexistent/file.mp3"));
    expect(bpm).toBe(0);
  });
});

// --- Version ---

describe("version", () => {
  test("dj_zig_version returns a positive integer", () => {
    const version = s.dj_zig_version();
    expect(version).toBeGreaterThan(0);
  });
});
