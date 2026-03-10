/**
 * automation.test.ts — Tests for parameter automation lifecycle:
 * set, get value, is_active, cancel, and value progression via pull_frames.
 *
 * Uses direct FFI (dlopen) — no RPC/AudioEngine layer.
 */
import { beforeAll, afterAll, describe, test, expect, setDefaultTimeout } from "bun:test";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { resolve } from "path";
import { existsSync } from "fs";

setDefaultTimeout(30000);

const ASSETS = resolve(import.meta.dir, "../test-assets");
const BEAT_100 = resolve(ASSETS, "beat100.mp3");
const assetsExist = existsSync(BEAT_100);
const testIfAssets = assetsExist ? test : test.skip;

function cstr(s: string): Uint8Array {
  return new TextEncoder().encode(s + "\0");
}

function floatBuf(count: number): { buffer: Float32Array; pointer: Pointer } {
  const buffer = new Float32Array(count);
  return { buffer, pointer: ptr(buffer) as Pointer };
}

// Automation param/interp constants (must match types.zig)
const DJ_PARAM_FILTER = 0;
const DJ_PARAM_VOLUME = 1;
const DJ_PARAM_EQ_LO = 2;
const DJ_PARAM_EQ_MID = 3;
const DJ_PARAM_EQ_HI = 4;
const DJ_INTERP_LINEAR = 0;

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
    dj_play: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_stop: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_set_volume: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_set_automation: {
      args: [FFIType.ptr, FFIType.i32, FFIType.f32, FFIType.f32, FFIType.f32, FFIType.i32],
      returns: FFIType.void,
    },
    dj_cancel_automation: {
      args: [FFIType.ptr, FFIType.i32],
      returns: FFIType.void,
    },
    dj_get_automation_value: {
      args: [FFIType.ptr, FFIType.i32],
      returns: FFIType.f32,
    },
    dj_is_automation_active: {
      args: [FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    dj_get_filter: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_get_eq_lo: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_pull_frames: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  s = lib.symbols;
  s.dj_init();
});

afterAll(() => {
  s?.dj_shutdown();
  setTimeout(() => process.exit(0), 100);
});

describe("automation lifecycle", () => {
  testIfAssets("set_automation activates and get_value returns start_val", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    // Not active initially
    expect(s.dj_is_automation_active(sound!, DJ_PARAM_FILTER)).toBe(0);
    // Returns -1 when not active
    expect(s.dj_get_automation_value(sound!, DJ_PARAM_FILTER)).toBe(-1);

    // Set automation: filter from -1.0 to 1.0 over 2 seconds
    s.dj_set_automation(sound!, DJ_PARAM_FILTER, -1.0, 1.0, 2.0, DJ_INTERP_LINEAR);

    expect(s.dj_is_automation_active(sound!, DJ_PARAM_FILTER)).toBe(1);
    // Current value should be start_val initially
    expect(s.dj_get_automation_value(sound!, DJ_PARAM_FILTER)).toBeCloseTo(-1.0, 1);
    // Filter should be set to start_val
    expect(s.dj_get_filter(sound!)).toBeCloseTo(-1.0, 1);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });

  testIfAssets("cancel_automation deactivates", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    s.dj_set_automation(sound!, DJ_PARAM_EQ_LO, 0.0, 1.5, 1.0, DJ_INTERP_LINEAR);
    expect(s.dj_is_automation_active(sound!, DJ_PARAM_EQ_LO)).toBe(1);

    s.dj_cancel_automation(sound!, DJ_PARAM_EQ_LO);
    expect(s.dj_is_automation_active(sound!, DJ_PARAM_EQ_LO)).toBe(0);
    // Returns -1 after cancel
    expect(s.dj_get_automation_value(sound!, DJ_PARAM_EQ_LO)).toBe(-1);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });

  testIfAssets("automation on different params are independent", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    s.dj_set_automation(sound!, DJ_PARAM_FILTER, -1.0, 1.0, 2.0, DJ_INTERP_LINEAR);
    s.dj_set_automation(sound!, DJ_PARAM_VOLUME, 0.0, 1.0, 1.0, DJ_INTERP_LINEAR);

    expect(s.dj_is_automation_active(sound!, DJ_PARAM_FILTER)).toBe(1);
    expect(s.dj_is_automation_active(sound!, DJ_PARAM_VOLUME)).toBe(1);
    expect(s.dj_is_automation_active(sound!, DJ_PARAM_EQ_LO)).toBe(0);

    // Cancel one, other stays active
    s.dj_cancel_automation(sound!, DJ_PARAM_FILTER);
    expect(s.dj_is_automation_active(sound!, DJ_PARAM_FILTER)).toBe(0);
    expect(s.dj_is_automation_active(sound!, DJ_PARAM_VOLUME)).toBe(1);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });

  testIfAssets("out-of-range param is silently ignored", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    // Should not crash
    s.dj_set_automation(sound!, -1, 0.0, 1.0, 1.0, DJ_INTERP_LINEAR);
    s.dj_set_automation(sound!, 99, 0.0, 1.0, 1.0, DJ_INTERP_LINEAR);
    expect(s.dj_is_automation_active(sound!, -1)).toBe(0);
    expect(s.dj_is_automation_active(sound!, 99)).toBe(0);
    expect(s.dj_get_automation_value(sound!, -1)).toBe(-1);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });

  testIfAssets("automation value progresses after pulling frames", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    // Do NOT call dj_play — use dj_pull_frames only (offline mode)
    // to avoid dual-path audio pulling which crashes Bun FFI.

    // Set EQ_LO automation: 0.0 → 2.0 over 1 second (44100 frames)
    s.dj_set_automation(sound!, DJ_PARAM_EQ_LO, 0.0, 2.0, 1.0, DJ_INTERP_LINEAR);
    const startVal = s.dj_get_automation_value(sound!, DJ_PARAM_EQ_LO);
    expect(startVal).toBeCloseTo(0.0, 1);

    // Pull ~22050 frames (0.5s at 44100Hz) to advance automation halfway
    const { pointer: pullBuf } = floatBuf(4096);
    let totalPulled = 0;
    while (totalPulled < 22050) {
      const pulled = s.dj_pull_frames(sound!, pullBuf, 2048);
      if (pulled <= 0) break;
      totalPulled += pulled;
    }

    // Value should have progressed toward end_val
    const midVal = s.dj_get_automation_value(sound!, DJ_PARAM_EQ_LO);
    // At 50%, linear interp should give ~1.0 (with some tolerance for frame timing)
    expect(midVal).toBeGreaterThan(0.3);
    expect(midVal).toBeLessThan(1.7);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});
