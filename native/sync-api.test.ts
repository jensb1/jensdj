/**
 * sync-api.test.ts — Tests for sync engine API: register/unregister track,
 * master BPM, global phase, sync_play, get_sync_diff, cancel_scheduled_start.
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
const BEAT_120 = resolve(ASSETS, "beat120.mp3");
const BEAT_125 = resolve(ASSETS, "beat125.mp3");

const assetsExist = existsSync(BEAT_100) && existsSync(BEAT_120) && existsSync(BEAT_125);
const testIfAssets = assetsExist ? test : test.skip;

function cstr(s: string): Uint8Array {
  return new TextEncoder().encode(s + "\0");
}

function floatBuf(count: number): { buffer: Float32Array; pointer: Pointer } {
  const buffer = new Float32Array(count);
  return { buffer, pointer: ptr(buffer) as Pointer };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    dj_pause: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_stop: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_seek: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.i32 },
    dj_get_position: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_is_playing: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_set_volume: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_set_tempo: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_get_tempo: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_set_original_bpm: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_get_original_bpm: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_set_global_clock: { args: [FFIType.f32], returns: FFIType.void },
    dj_align_global_clock: { args: [FFIType.ptr], returns: FFIType.void },
    dj_get_global_phase: { returns: FFIType.f32 },
    dj_set_beat_ref: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_get_beat_ref: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_sync_start: {
      args: [FFIType.ptr, FFIType.f32, FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.i32],
      returns: FFIType.i32,
    },
    dj_cancel_scheduled_start: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_get_sync_diff: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.f32, FFIType.f32],
      returns: FFIType.f32,
    },
    dj_get_track_sync_diff: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_set_beats: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.void },
    dj_free_beat_grid: { args: [FFIType.ptr], returns: FFIType.void },
    dj_sync_play: { args: [FFIType.ptr, FFIType.ptr, FFIType.f32], returns: FFIType.i32 },
    dj_set_master_bpm: { args: [FFIType.f32], returns: FFIType.void },
    dj_get_master_bpm: { returns: FFIType.f32 },
    dj_register_track: { args: [FFIType.ptr], returns: FFIType.void },
    dj_unregister_track: { args: [FFIType.ptr], returns: FFIType.void },
    dj_detect_beats: { args: [FFIType.cstring, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    dj_pull_frames: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  s = lib.symbols;
  s.dj_init();
});

afterAll(() => {
  s?.dj_shutdown();
  setTimeout(() => process.exit(0), 100);
});

// --- Master BPM ---

describe("master BPM", () => {
  test("set/get master BPM roundtrip", () => {
    s.dj_set_master_bpm(120.0);
    expect(s.dj_get_master_bpm()).toBeCloseTo(120.0, 1);

    s.dj_set_master_bpm(140.0);
    expect(s.dj_get_master_bpm()).toBeCloseTo(140.0, 1);

    // Reset
    s.dj_set_master_bpm(0);
    expect(s.dj_get_master_bpm()).toBe(0);
  });

  testIfAssets("set_master_bpm adjusts tempo of registered tracks", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    s.dj_set_original_bpm(sound!, 100.0);
    s.dj_register_track(sound!);

    // Set master BPM to 120 → tempo should be 120/100 = 1.2
    s.dj_set_master_bpm(120.0);
    const tempo = s.dj_get_tempo(sound!);
    expect(tempo).toBeCloseTo(1.2, 2);

    // Change to 100 → tempo should be 1.0
    s.dj_set_master_bpm(100.0);
    expect(s.dj_get_tempo(sound!)).toBeCloseTo(1.0, 2);

    // Reset to 0 → tempo should be 1.0
    s.dj_set_master_bpm(0);
    expect(s.dj_get_tempo(sound!)).toBeCloseTo(1.0, 2);

    s.dj_unregister_track(sound!);
    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Track Registration ---

describe("track registration", () => {
  testIfAssets("register and unregister don't crash", () => {
    const engine = s.dj_create_engine(-1);
    const sound1 = s.dj_load_sound(engine!, cstr(BEAT_100));
    const sound2 = s.dj_load_sound(engine!, cstr(BEAT_120));
    expect(sound1).not.toBe(null);
    expect(sound2).not.toBe(null);

    s.dj_register_track(sound1!);
    s.dj_register_track(sound2!);

    // Unregister in reverse order
    s.dj_unregister_track(sound2!);
    s.dj_unregister_track(sound1!);

    // Double unregister should not crash
    s.dj_unregister_track(sound1!);

    s.dj_unload_sound(sound1!);
    s.dj_unload_sound(sound2!);
    s.dj_destroy_engine(engine!);
  });

  testIfAssets("unregistered track is not affected by set_master_bpm", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    s.dj_set_original_bpm(sound!, 100.0);
    s.dj_set_tempo(sound!, 1.0);
    // NOT registered

    s.dj_set_master_bpm(150.0);
    // Tempo should remain 1.0 (not affected)
    expect(s.dj_get_tempo(sound!)).toBeCloseTo(1.0, 2);

    s.dj_set_master_bpm(0);
    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Global Phase ---

describe("global phase", () => {
  test("dj_get_global_phase returns 0 when no clock is set", () => {
    // Reset global clock state
    s.dj_set_master_bpm(0);
    const phase = s.dj_get_global_phase();
    expect(phase).toBe(0);
  });

  testIfAssets("dj_get_global_phase returns value in [0, bar_duration) after clock set", async () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    // 100 BPM → bar_duration = 4 * 60 / 100 = 2.4s
    const barDuration = 2.4;
    s.dj_set_global_clock(barDuration);

    // Let some time pass
    s.dj_set_volume(sound!, 0);
    s.dj_play(sound!);
    await sleep(200);

    const phase = s.dj_get_global_phase();
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(barDuration);

    s.dj_stop(sound!);
    s.dj_set_master_bpm(0);
    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Get Sync Diff ---

describe("sync diff", () => {
  testIfAssets("dj_get_sync_diff computes phase difference between two tracks", async () => {
    const engine = s.dj_create_engine(-1);
    const sound1 = s.dj_load_sound(engine!, cstr(BEAT_100));
    const sound2 = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound1).not.toBe(null);
    expect(sound2).not.toBe(null);

    const barDuration = 2.4; // 100 BPM

    s.dj_set_volume(sound1!, 0);
    s.dj_set_volume(sound2!, 0);
    s.dj_set_beat_ref(sound1!, 0);
    s.dj_set_beat_ref(sound2!, 0);

    // Start both at same position
    s.dj_seek(sound1!, 0);
    s.dj_seek(sound2!, 0);
    s.dj_play(sound1!);
    s.dj_play(sound2!);
    await sleep(200);

    // Both at same position → diff should be near 0
    const diff = s.dj_get_sync_diff(sound1!, sound2!, 0, barDuration);
    expect(Math.abs(diff)).toBeLessThan(0.1);

    s.dj_stop(sound1!);
    s.dj_stop(sound2!);
    s.dj_unload_sound(sound1!);
    s.dj_unload_sound(sound2!);
    s.dj_destroy_engine(engine!);
  });

  testIfAssets("dj_get_track_sync_diff returns 0 when phase not active", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    // Without sync, phase_active = 0 → diff = 0
    const diff = s.dj_get_track_sync_diff(sound!);
    expect(diff).toBe(0);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Cancel Scheduled Start ---

describe("cancel scheduled start", () => {
  testIfAssets("dj_cancel_scheduled_start stops a playing sound", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    s.dj_set_volume(sound!, 0);
    s.dj_play(sound!);
    expect(s.dj_is_playing(sound!)).toBe(1);

    s.dj_cancel_scheduled_start(sound!);
    expect(s.dj_is_playing(sound!)).toBe(0);

    s.dj_unload_sound(sound!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Sync Play (with beat grid) ---

describe("dj_sync_play", () => {
  testIfAssets("sync_play aligns target to source beat grid", async () => {
    const engine = s.dj_create_engine(-1);
    const source = s.dj_load_sound(engine!, cstr(BEAT_100));
    const target = s.dj_load_sound(engine!, cstr(BEAT_120));
    expect(source).not.toBe(null);
    expect(target).not.toBe(null);

    // Detect beats for both
    const maxBeats = 500;
    const { buffer: srcBeats, pointer: srcBeatPtr } = floatBuf(maxBeats);
    const srcCount = s.dj_detect_beats(cstr(BEAT_100), srcBeatPtr, maxBeats);
    expect(srcCount).toBeGreaterThan(10);

    const { buffer: tgtBeats, pointer: tgtBeatPtr } = floatBuf(maxBeats);
    const tgtCount = s.dj_detect_beats(cstr(BEAT_120), tgtBeatPtr, maxBeats);
    expect(tgtCount).toBeGreaterThan(10);

    // Set beats on both sounds
    s.dj_set_beats(source!, srcBeatPtr, srcCount);
    s.dj_set_beats(target!, tgtBeatPtr, tgtCount);

    s.dj_set_original_bpm(source!, 100.0);
    s.dj_set_original_bpm(target!, 120.0);

    s.dj_set_volume(source!, 0);
    s.dj_set_volume(target!, 0);

    // Start source playing
    s.dj_play(source!);
    await sleep(300);

    // Sync play target to source
    const result = s.dj_sync_play(target!, source!, -1);
    expect(result).toBe(0);

    await sleep(200);
    expect(s.dj_is_playing(target!)).toBe(1);

    // Clean up beat grids
    s.dj_free_beat_grid(source!);
    s.dj_free_beat_grid(target!);

    s.dj_stop(source!);
    s.dj_stop(target!);
    s.dj_unload_sound(source!);
    s.dj_unload_sound(target!);
    s.dj_destroy_engine(engine!);
  });

  testIfAssets("sync_play returns -1 without beat grids", () => {
    const engine = s.dj_create_engine(-1);
    const source = s.dj_load_sound(engine!, cstr(BEAT_100));
    const target = s.dj_load_sound(engine!, cstr(BEAT_120));
    expect(source).not.toBe(null);
    expect(target).not.toBe(null);

    // No beats set → should fail
    const result = s.dj_sync_play(target!, source!, -1);
    expect(result).toBe(-1);

    s.dj_unload_sound(source!);
    s.dj_unload_sound(target!);
    s.dj_destroy_engine(engine!);
  });
});

// --- Free Beat Grid ---

describe("beat grid lifecycle", () => {
  testIfAssets("set_beats then free_beat_grid", () => {
    const engine = s.dj_create_engine(-1);
    const sound = s.dj_load_sound(engine!, cstr(BEAT_100));
    expect(sound).not.toBe(null);

    const maxBeats = 500;
    const { pointer: beatPtr } = floatBuf(maxBeats);
    const count = s.dj_detect_beats(cstr(BEAT_100), beatPtr, maxBeats);
    expect(count).toBeGreaterThan(5);

    // Set and free without crash
    s.dj_set_beats(sound!, beatPtr, count);
    s.dj_free_beat_grid(sound!);

    // Double free should not crash
    s.dj_free_beat_grid(sound!);

    // sync_play should fail after free (no beat grid)
    const sound2 = s.dj_load_sound(engine!, cstr(BEAT_120));
    const result = s.dj_sync_play(sound!, sound2!, -1);
    expect(result).toBe(-1);

    s.dj_unload_sound(sound!);
    s.dj_unload_sound(sound2!);
    s.dj_destroy_engine(engine!);
  });
});
