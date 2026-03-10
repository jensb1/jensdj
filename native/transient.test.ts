/**
 * transient.test.ts — Validates audio processing pipeline (RubberBand stretch + EQ + mixing)
 * preserves transient integrity using test beat tracks at known BPMs.
 *
 * Uses direct FFI (dlopen) — no RPC/AudioEngine layer.
 * Test assets: test-assets/beat100.mp3, beat120.mp3, beat125.mp3
 */
import { beforeAll, afterAll, describe, test, expect, setDefaultTimeout } from "bun:test";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { resolve } from "path";
import { existsSync } from "fs";

setDefaultTimeout(30000);

// --- Test asset paths ---
const ASSETS = resolve(import.meta.dir, "../test-assets");
const BEAT_100 = resolve(ASSETS, "beat100.mp3");
const BEAT_120 = resolve(ASSETS, "beat120.mp3");
const BEAT_125 = resolve(ASSETS, "beat125.mp3");

const assetsExist =
  existsSync(BEAT_100) && existsSync(BEAT_120) && existsSync(BEAT_125);
const testIfAssets = assetsExist ? test : test.skip;

// --- FFI helpers ---
function cstr(s: string): Uint8Array {
  return new TextEncoder().encode(s + "\0");
}

function floatBuf(count: number): { buffer: Float32Array; pointer: Pointer } {
  const buffer = new Float32Array(count);
  return { buffer, pointer: ptr(buffer) as Pointer };
}

// --- Direct FFI bindings ---
const LIB_PATH = resolve(import.meta.dir, "libdjengine.dylib");
let lib: ReturnType<typeof dlopen>;
let s: typeof lib.symbols;

beforeAll(async () => {
  await Bun.$`cd native && zig build`.quiet();

  lib = dlopen(LIB_PATH, {
    dj_init: { returns: FFIType.i32 },
    dj_shutdown: { returns: FFIType.void },
    dj_create_engine: { args: [FFIType.i32], returns: FFIType.ptr },
    dj_destroy_engine: { args: [FFIType.ptr], returns: FFIType.void },
    dj_load_sound: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
    dj_unload_sound: { args: [FFIType.ptr], returns: FFIType.void },
    dj_set_tempo: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_get_tempo: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_set_original_bpm: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_seek: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.i32 },
    dj_set_volume: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_set_eq: {
      args: [FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.f32],
      returns: FFIType.void,
    },
    dj_detect_beats: {
      args: [FFIType.cstring, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    dj_pull_frames: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    dj_find_transients: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    dj_get_sample_rate: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  s = lib.symbols;

  s.dj_init();
});

afterAll(() => {
  s?.dj_shutdown();
});

// --- TS-side helpers ---

/** Convert stereo interleaved to mono by averaging channels */
function toMono(stereo: Float32Array, numFrames: number): Float32Array {
  const mono = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    mono[i] = (stereo[i * 2]! + stereo[i * 2 + 1]!) / 2;
  }
  return mono;
}

/** Compute crest factor in dB (peak/RMS) for a window around each transient */
function computeCrestFactor(
  pcm: Float32Array,
  sampleRate: number,
  transientTimes: Float32Array,
  windowMs: number = 20
): number {
  const windowSamples = Math.floor((windowMs / 1000) * sampleRate);
  let totalPeak = 0;
  let totalRms = 0;
  let count = 0;

  for (const t of transientTimes) {
    const center = Math.floor(t * sampleRate);
    const start = Math.max(0, center - windowSamples);
    const end = Math.min(pcm.length, center + windowSamples);

    let peak = 0;
    let sumSq = 0;
    let n = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(pcm[i]!);
      if (v > peak) peak = v;
      sumSq += pcm[i]! * pcm[i]!;
      n++;
    }
    if (n > 0 && peak > 0) {
      totalPeak += peak;
      totalRms += Math.sqrt(sumSq / n);
      count++;
    }
  }

  if (count === 0 || totalRms === 0) return 0;
  return 20 * Math.log10(totalPeak / totalRms);
}

/** TS-side transient detection (independent cross-check) */
function tsDetectTransients(
  pcm: Float32Array,
  sampleRate: number,
  minInterval: number = 0.2
): number[] {
  // Simple envelope follower
  let envelope = 0;
  const attack = 0.005;
  const release = 0.0005;
  const threshold = 0.015;
  let inTransient = false;
  let lastTime = -1;
  const times: number[] = [];

  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.abs(pcm[i]!);
    if (sample > envelope) {
      envelope += attack * (sample - envelope);
    } else {
      envelope += release * (sample - envelope);
    }

    const t = i / sampleRate;
    if (!inTransient && envelope > threshold) {
      if (lastTime < 0 || t - lastTime > minInterval) {
        times.push(t);
        lastTime = t;
      }
      inTransient = true;
    } else if (inTransient && envelope < threshold * 0.5) {
      inTransient = false;
    }
  }
  return times;
}

/** Pull N seconds of audio from a sound handle */
function pullSeconds(
  soundPtr: Pointer,
  seconds: number,
  sampleRate: number
): { stereo: Float32Array; mono: Float32Array; framesRead: number } {
  const numFrames = Math.ceil(seconds * sampleRate);
  const { buffer: stereo, pointer: bufPtr } = floatBuf(numFrames * 2);
  const framesRead = s.dj_pull_frames(soundPtr, bufPtr, numFrames);
  const mono = toMono(stereo, framesRead);
  return { stereo, mono, framesRead };
}

/** Detect transients using C API on mono PCM */
function cDetectTransients(
  mono: Float32Array,
  sampleRate: number
): Float32Array {
  const maxT = 500;
  const { buffer: outBuf, pointer: outPtr } = floatBuf(maxT);
  const count = s.dj_find_transients(
    ptr(mono) as Pointer,
    mono.length,
    sampleRate,
    outPtr,
    maxT
  );
  return outBuf.subarray(0, count);
}

/** Compute beat intervals from transient times */
function intervals(times: Float32Array | number[]): number[] {
  const iv: number[] = [];
  for (let i = 1; i < times.length; i++) {
    iv.push((times[i] as number) - (times[i - 1] as number));
  }
  return iv;
}

/** Mean of an array */
function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ==========================================================
// Test Suite
// ==========================================================

describe("transient integrity", () => {
  // Shared engine pointer
  let engine: Pointer;

  beforeAll(() => {
    engine = s.dj_create_engine(-1)!;
    expect(engine).not.toBeNull();
  });

  afterAll(() => {
    if (engine) s.dj_destroy_engine(engine);
  });

  // Test 1: Baseline (no stretch) — 120 BPM track at 1.0x
  testIfAssets("baseline: transients at ~500ms intervals (120 BPM, no stretch)", () => {
    const sound = s.dj_load_sound(engine, cstr(BEAT_120))!;
    expect(sound).not.toBeNull();

    try {
      const sr = s.dj_get_sample_rate(sound);
      expect(sr).toBeGreaterThan(0);

      // Detect beats to find first beat position
      const { buffer: beatBuf, pointer: beatPtr } = floatBuf(2000);
      const nBeats = s.dj_detect_beats(cstr(BEAT_120), beatPtr, 2000);
      expect(nBeats).toBeGreaterThan(0);
      const firstBeat = beatBuf[0]!;

      // Seek to first beat
      s.dj_seek(sound, firstBeat);

      // Pull 5 seconds of audio
      const { mono, framesRead } = pullSeconds(sound, 5, sr);
      expect(framesRead).toBeGreaterThan(sr * 4); // at least 4s

      // Detect transients
      const transients = cDetectTransients(mono, sr);
      console.log(
        `[baseline] ${transients.length} transients, firstBeat=${firstBeat.toFixed(3)}s, sr=${sr}`
      );

      // Should have ~10 transients in 5 seconds at 120 BPM
      expect(transients.length).toBeGreaterThanOrEqual(8);
      expect(transients.length).toBeLessThanOrEqual(12);

      // Skip first interval (detector cold-start), verify all others are on grid
      const ivs = intervals(transients);
      console.log(`[baseline] intervals: ${ivs.map(v => (v * 1000).toFixed(1) + "ms").join(", ")}`);
      for (let i = 1; i < ivs.length; i++) {
        expect(Math.abs(ivs[i]! - 0.5)).toBeLessThan(0.002); // 500ms ± 2ms
      }
    } finally {
      s.dj_unload_sound(sound);
    }
  });

  // Test 2: Single track stretched — 100 BPM → 120 BPM (1.2x)
  testIfAssets("stretched: 100 BPM → 120 BPM produces ~500ms intervals", () => {
    const sound = s.dj_load_sound(engine, cstr(BEAT_100))!;
    expect(sound).not.toBeNull();

    try {
      const sr = s.dj_get_sample_rate(sound);

      // Set original BPM and stretch to 120
      s.dj_set_original_bpm(sound, 100);
      s.dj_set_tempo(sound, 120 / 100); // 1.2x

      // Detect beats for first beat position
      const { buffer: beatBuf, pointer: beatPtr } = floatBuf(2000);
      s.dj_detect_beats(cstr(BEAT_100), beatPtr, 2000);
      const firstBeat = beatBuf[0]!;

      s.dj_seek(sound, firstBeat);

      // Pull 5 seconds (output time — corresponds to 6s input time at 1.2x)
      const { mono, framesRead } = pullSeconds(sound, 5, sr);
      expect(framesRead).toBeGreaterThan(sr * 4);

      const transients = cDetectTransients(mono, sr);
      console.log(
        `[stretched] ${transients.length} transients, tempo=1.2x`
      );

      expect(transients.length).toBeGreaterThanOrEqual(8);
      expect(transients.length).toBeLessThanOrEqual(12);

      const ivs = intervals(transients);
      console.log(`[stretched] intervals: ${ivs.map(v => (v * 1000).toFixed(1) + "ms").join(", ")}`);
      // Skip first interval (detector cold-start), verify all others are on grid
      for (let i = 1; i < ivs.length; i++) {
        expect(Math.abs(ivs[i]! - 0.5)).toBeLessThan(0.002); // 500ms ± 2ms
      }
    } finally {
      s.dj_unload_sound(sound);
    }
  });

  // Test 3: Two tracks mixed — both stretched to 120 BPM, beat-aligned
  testIfAssets("mixed: two tracks at 120 BPM produce single aligned transient set", () => {
    const sound1 = s.dj_load_sound(engine, cstr(BEAT_100))!;
    const sound2 = s.dj_load_sound(engine, cstr(BEAT_125))!;
    expect(sound1).not.toBeNull();
    expect(sound2).not.toBeNull();

    try {
      const sr = s.dj_get_sample_rate(sound1);

      // Stretch both to 120 BPM
      s.dj_set_original_bpm(sound1, 100);
      s.dj_set_tempo(sound1, 120 / 100);
      s.dj_set_original_bpm(sound2, 125);
      s.dj_set_tempo(sound2, 120 / 125);

      // Get first beats
      const { buffer: b1, pointer: bp1 } = floatBuf(2000);
      const { buffer: b2, pointer: bp2 } = floatBuf(2000);
      s.dj_detect_beats(cstr(BEAT_100), bp1, 2000);
      s.dj_detect_beats(cstr(BEAT_125), bp2, 2000);

      s.dj_seek(sound1, b1[0]!);
      s.dj_seek(sound2, b2[0]!);

      // Pull 5 seconds from each and mix
      const numFrames = Math.ceil(5 * sr);
      const { buffer: stereo1, pointer: buf1Ptr } = floatBuf(numFrames * 2);
      const { buffer: stereo2, pointer: buf2Ptr } = floatBuf(numFrames * 2);

      const fr1 = s.dj_pull_frames(sound1, buf1Ptr, numFrames);
      const fr2 = s.dj_pull_frames(sound2, buf2Ptr, numFrames);
      const mixFrames = Math.min(fr1, fr2);

      // Mix stereo
      const mixed = new Float32Array(mixFrames * 2);
      for (let i = 0; i < mixFrames * 2; i++) {
        mixed[i] = (stereo1[i]! + stereo2[i]!) / 2;
      }
      const mixMono = toMono(mixed, mixFrames);

      const transients = cDetectTransients(mixMono, sr);
      console.log(
        `[mixed] ${transients.length} transients in ${(mixFrames / sr).toFixed(1)}s`
      );

      // Should still see ~10 transients (not doubled to ~20)
      expect(transients.length).toBeGreaterThanOrEqual(8);
      expect(transients.length).toBeLessThanOrEqual(12);

      const ivs = intervals(transients);
      console.log(`[mixed] intervals: ${ivs.map(v => (v * 1000).toFixed(1) + "ms").join(", ")}`);
      // Skip first interval (detector cold-start), verify all others are on grid
      for (let i = 1; i < ivs.length; i++) {
        expect(Math.abs(ivs[i]! - 0.5)).toBeLessThan(0.002); // 500ms ± 2ms
      }
    } finally {
      s.dj_unload_sound(sound1);
      s.dj_unload_sound(sound2);
    }
  });

  // Test 4: Stretch quality — crest factor preserved
  testIfAssets("stretch quality: crest factor preserved after stretching", () => {
    // Baseline: 120 BPM at 1.0x
    const baseline = s.dj_load_sound(engine, cstr(BEAT_120))!;
    const stretched = s.dj_load_sound(engine, cstr(BEAT_100))!;

    try {
      const sr = s.dj_get_sample_rate(baseline);

      // Pull baseline
      const { buffer: bb, pointer: bbp } = floatBuf(2000);
      s.dj_detect_beats(cstr(BEAT_120), bbp, 2000);
      s.dj_seek(baseline, bb[0]!);
      const baseResult = pullSeconds(baseline, 5, sr);
      const baseTransients = cDetectTransients(baseResult.mono, sr);
      const baseCrest = computeCrestFactor(baseResult.mono, sr, baseTransients);

      // Stretched: 100 → 120 BPM
      s.dj_set_original_bpm(stretched, 100);
      s.dj_set_tempo(stretched, 1.2);
      const { buffer: sb, pointer: sbp } = floatBuf(2000);
      s.dj_detect_beats(cstr(BEAT_100), sbp, 2000);
      s.dj_seek(stretched, sb[0]!);
      const stretchResult = pullSeconds(stretched, 5, sr);
      const stretchTransients = cDetectTransients(stretchResult.mono, sr);
      const stretchCrest = computeCrestFactor(
        stretchResult.mono,
        sr,
        stretchTransients
      );

      console.log(
        `[quality] baseCrest=${baseCrest.toFixed(1)}dB stretchCrest=${stretchCrest.toFixed(1)}dB`
      );

      // Both should have > 6 dB crest factor (clean transients)
      expect(baseCrest).toBeGreaterThan(6);
      expect(stretchCrest).toBeGreaterThan(6);
      // Stretched should be within 3 dB of baseline
      expect(Math.abs(stretchCrest - baseCrest)).toBeLessThan(3);
    } finally {
      s.dj_unload_sound(baseline);
      s.dj_unload_sound(stretched);
    }
  });

  // Test 5: EQ doesn't kill kicks — lo=1, mid=0, hi=0
  testIfAssets("EQ: killing mids+highs preserves low-band transients", () => {
    const sound = s.dj_load_sound(engine, cstr(BEAT_120))!;
    expect(sound).not.toBeNull();

    try {
      const sr = s.dj_get_sample_rate(sound);

      // Kill mids and highs
      s.dj_set_eq(sound, 1.0, 0.0, 0.0);

      const { buffer: bb, pointer: bbp } = floatBuf(2000);
      s.dj_detect_beats(cstr(BEAT_120), bbp, 2000);
      s.dj_seek(sound, bb[0]!);

      const { mono, framesRead } = pullSeconds(sound, 3, sr);
      expect(framesRead).toBeGreaterThan(sr * 2);

      const transients = cDetectTransients(mono, sr);
      console.log(
        `[eq_kick] ${transients.length} transients with lo=1 mid=0 hi=0`
      );

      // Should still detect at least 4 kick transients in 3 seconds
      expect(transients.length).toBeGreaterThanOrEqual(4);
    } finally {
      s.dj_unload_sound(sound);
    }
  });

  // Test 6: Post-stretch BPM — compute BPM from transient intervals
  testIfAssets("post-stretch BPM: 100 BPM → 120 BPM verified from output", () => {
    const sound = s.dj_load_sound(engine, cstr(BEAT_100))!;
    expect(sound).not.toBeNull();

    try {
      const sr = s.dj_get_sample_rate(sound);

      s.dj_set_original_bpm(sound, 100);
      s.dj_set_tempo(sound, 120 / 100);

      const { buffer: bb, pointer: bbp } = floatBuf(2000);
      s.dj_detect_beats(cstr(BEAT_100), bbp, 2000);
      s.dj_seek(sound, bb[0]!);

      // Pull 10 seconds for better BPM accuracy
      const { mono, framesRead } = pullSeconds(sound, 10, sr);
      expect(framesRead).toBeGreaterThan(sr * 8);

      const transients = cDetectTransients(mono, sr);
      console.log(`[bpm] ${transients.length} transients in 10s`);

      expect(transients.length).toBeGreaterThanOrEqual(15);

      // Compute BPM from mean interval
      const ivs = intervals(transients);
      const meanIv = mean(ivs);
      const bpm = 60 / meanIv;

      console.log(
        `[bpm] meanInterval=${(meanIv * 1000).toFixed(1)}ms → BPM=${bpm.toFixed(1)}`
      );

      // 120 BPM ± 0.5
      expect(Math.abs(bpm - 120)).toBeLessThan(0.5);
    } finally {
      s.dj_unload_sound(sound);
    }
  });

  // Cross-check: TS transient detection agrees with C
  testIfAssets("cross-check: TS and C transient detectors agree", () => {
    const sound = s.dj_load_sound(engine, cstr(BEAT_120))!;

    try {
      const sr = s.dj_get_sample_rate(sound);

      const { buffer: bb, pointer: bbp } = floatBuf(2000);
      s.dj_detect_beats(cstr(BEAT_120), bbp, 2000);
      s.dj_seek(sound, bb[0]!);

      const { mono } = pullSeconds(sound, 5, sr);

      const cTransients = cDetectTransients(mono, sr);
      const tsTransients = tsDetectTransients(mono, sr);

      console.log(
        `[crosscheck] C=${cTransients.length} TS=${tsTransients.length}`
      );

      // Should find similar number of transients
      expect(Math.abs(cTransients.length - tsTransients.length)).toBeLessThan(3);

      // For each C transient, TS should have one nearby
      for (let i = 0; i < Math.min(cTransients.length, tsTransients.length); i++) {
        const cTime = cTransients[i]!;
        const tsTime = tsTransients[i]!;
        expect(Math.abs(cTime - tsTime)).toBeLessThan(0.05); // within 50ms
      }
    } finally {
      s.dj_unload_sound(sound);
    }
  });
});
