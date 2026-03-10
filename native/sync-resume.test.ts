/**
 * sync-resume.test.ts — Verifies that track 2 resumes in sync with track 1
 * after pause/stop at varying intervals, across different BPM combinations.
 *
 * Uses direct FFI with real audio device playback (not offline pulls).
 * Bar-phase alignment is checked by reading file-time positions after each resume.
 */
import { beforeAll, afterAll, afterEach, describe, test, expect, setDefaultTimeout } from "bun:test";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { resolve } from "path";
import { existsSync } from "fs";

setDefaultTimeout(60000);

const ASSETS = resolve(import.meta.dir, "../test-assets");
const BEAT_100 = resolve(ASSETS, "beat100.mp3");
const BEAT_120 = resolve(ASSETS, "beat120.mp3");
const BEAT_125 = resolve(ASSETS, "beat125.mp3");

const assetsExist =
  existsSync(BEAT_100) && existsSync(BEAT_120) && existsSync(BEAT_125);
const testIfAssets = assetsExist ? test : test.skip;

function cstr(s: string): Uint8Array {
  return new TextEncoder().encode(s + "\0");
}
function floatBuf(count: number) {
  const buffer = new Float32Array(count);
  return { buffer, pointer: ptr(buffer) as Pointer };
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
    dj_sync_start: {
      args: [FFIType.ptr, FFIType.f32, FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.i32],
      returns: FFIType.i32,
    },
    dj_detect_beats: {
      args: [FFIType.cstring, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    dj_get_sample_rate: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_get_track_sync_diff: { args: [FFIType.ptr], returns: FFIType.f32 },
  });
  s = lib.symbols;
  s.dj_init();
});

afterAll(() => {
  s?.dj_shutdown();
});

// --- Helpers ---

/** Detect first beat for a track file */
function getFirstBeat(filepath: string): number {
  const { buffer, pointer } = floatBuf(2000);
  s.dj_detect_beats(cstr(filepath), pointer, 2000);
  return buffer[0]!;
}

/** Compute bar duration from BPM (4 beats per bar) */
function barDuration(bpm: number): number {
  return (4 * 60) / bpm;
}

/** Bar-phase of a position relative to a beat reference */
function barPhase(position: number, beatRef: number, barDur: number): number {
  let phase = (position - beatRef) % barDur;
  if (phase < 0) phase += barDur;
  return phase;
}

/** Signed phase diff (wraps around bar boundary) */
function phaseDiff(phase1: number, phase2: number, barDur: number): number {
  let diff = phase1 - phase2;
  if (diff > barDur / 2) diff -= barDur;
  if (diff < -barDur / 2) diff += barDur;
  return diff;
}

/** Read positions and compute bar-phase diff between two tracks.
 *  dj_get_position returns file-time, so we convert to output-time
 *  using time_ratio (= bpm/masterBpm) before computing bar-phase. */
function measurePhaseDiff(
  sound1: Pointer,
  beat1: number,
  bpm1: number,
  sound2: Pointer,
  beat2: number,
  bpm2: number,
  masterBpm: number,
  barDur: number
): { pos1: number; pos2: number; phase1: number; phase2: number; diffMs: number } {
  const pos1 = s.dj_get_position(sound1) as number; // file-time
  const pos2 = s.dj_get_position(sound2) as number; // file-time
  // time_ratio = bpm / masterBpm (RubberBand convention: 1/playbackSpeed)
  const tr1 = bpm1 / masterBpm;
  const tr2 = bpm2 / masterBpm;
  // Convert to output-time for phase comparison
  const phase1 = barPhase(pos1 * tr1, beat1 * tr1, barDur);
  const phase2 = barPhase(pos2 * tr2, beat2 * tr2, barDur);
  const diff = phaseDiff(phase1, phase2, barDur);
  return { pos1, pos2, phase1, phase2, diffMs: diff * 1000 };
}

// ==========================================================

describe("sync resume after pause/stop", () => {
  let engine: Pointer;

  beforeAll(() => {
    engine = s.dj_create_engine(-1)!;
    expect(engine).not.toBeNull();
  });

  afterAll(() => {
    if (engine) s.dj_destroy_engine(engine);
  });

  /**
   * Core test logic: play track1 at masterBpm, sync track2, then
   * pause/stop track2 at each interval and resume — verify sync each time.
   */
  async function runSyncResumeTest(opts: {
    file1: string;
    bpm1: number;
    file2: string;
    bpm2: number;
    masterBpm: number;
    pauseIntervals: number[];
    mode: "pause" | "stop";
  }) {
    const { file1, bpm1, file2, bpm2, masterBpm, pauseIntervals, mode } = opts;
    const bd = barDuration(masterBpm);
    const beat1 = getFirstBeat(file1);
    const beat2 = getFirstBeat(file2);

    const sound1 = s.dj_load_sound(engine, cstr(file1))!;
    const sound2 = s.dj_load_sound(engine, cstr(file2))!;
    expect(sound1).not.toBeNull();
    expect(sound2).not.toBeNull();

    try {
      // Mute both
      s.dj_set_volume(sound1, 0);
      s.dj_set_volume(sound2, 0);

      // Set BPMs
      s.dj_set_original_bpm(sound1, bpm1);
      s.dj_set_original_bpm(sound2, bpm2);

      // Set tempo to master
      s.dj_set_tempo(sound1, masterBpm / bpm1);

      // Start track 1
      s.dj_seek(sound1, beat1);
      s.dj_play(sound1);
      await sleep(500); // let it run a bit

      // Initial sync start of track 2
      const syncResult = s.dj_sync_start(sound2, beat2, sound1, beat1, bd, 0);
      expect(syncResult).toBe(0);
      await sleep(300);

      // Verify initial sync
      const initial = measurePhaseDiff(sound1, beat1, bpm1, sound2, beat2, bpm2, masterBpm, bd);
      console.log(
        `  [initial] pos1=${initial.pos1.toFixed(3)} pos2=${initial.pos2.toFixed(3)} diff=${initial.diffMs.toFixed(1)}ms`
      );
      expect(Math.abs(initial.diffMs)).toBeLessThan(30);

      // Run pause/resume cycles at each interval
      const results: { interval: number; diffMs: number }[] = [];

      for (const interval of pauseIntervals) {
        await sleep(interval);

        // Pause or stop track 2
        if (mode === "pause") {
          s.dj_pause(sound2);
        } else {
          s.dj_stop(sound2);
        }
        await sleep(100); // brief pause

        // Re-sync track 2
        const r = s.dj_sync_start(sound2, beat2, sound1, beat1, bd, 0);
        expect(r).toBe(0);

        // Let it settle then measure
        await sleep(200);

        const m = measurePhaseDiff(sound1, beat1, bpm1, sound2, beat2, bpm2, masterBpm, bd);
        results.push({ interval, diffMs: m.diffMs });

        console.log(
          `  [${mode} after ${interval}ms] pos1=${m.pos1.toFixed(3)} pos2=${m.pos2.toFixed(3)} diff=${m.diffMs.toFixed(1)}ms`
        );
      }

      // All resumes must be in sync
      for (const r of results) {
        expect(Math.abs(r.diffMs)).toBeLessThan(30);
      }

      // No drift: last should not be worse than first + 10ms
      const firstAbs = Math.abs(results[0]!.diffMs);
      const lastAbs = Math.abs(results[results.length - 1]!.diffMs);
      expect(lastAbs).toBeLessThan(firstAbs + 10);
    } finally {
      s.dj_stop(sound1);
      s.dj_stop(sound2);
      s.dj_unload_sound(sound1);
      s.dj_unload_sound(sound2);
    }
  }

  // --- Pause tests ---

  testIfAssets("pause/resume: 100 + 120 BPM at master 120", async () => {
    console.log("\n=== 100 + 120 BPM, master=120, pause ===");
    await runSyncResumeTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 120,
      pauseIntervals: [300, 500, 750, 1000, 1500],
      mode: "pause",
    });
  });

  testIfAssets("pause/resume: 120 + 125 BPM at master 122", async () => {
    console.log("\n=== 120 + 125 BPM, master=122, pause ===");
    await runSyncResumeTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_125,
      bpm2: 125,
      masterBpm: 122,
      pauseIntervals: [400, 600, 800, 1200],
      mode: "pause",
    });
  });

  testIfAssets("pause/resume: 125 + 100 BPM at master 110", async () => {
    console.log("\n=== 125 + 100 BPM, master=110, pause ===");
    await runSyncResumeTest({
      file1: BEAT_125,
      bpm1: 125,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 110,
      pauseIntervals: [350, 700, 1100, 1400],
      mode: "pause",
    });
  });

  // --- Stop tests ---

  testIfAssets("stop/restart: 100 + 120 BPM at master 120", async () => {
    console.log("\n=== 100 + 120 BPM, master=120, stop ===");
    await runSyncResumeTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 120,
      pauseIntervals: [300, 500, 750, 1000, 1500],
      mode: "stop",
    });
  });

  testIfAssets("stop/restart: 120 + 125 BPM at master 122", async () => {
    console.log("\n=== 120 + 125 BPM, master=122, stop ===");
    await runSyncResumeTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_125,
      bpm2: 125,
      masterBpm: 122,
      pauseIntervals: [400, 600, 800, 1200],
      mode: "stop",
    });
  });

  testIfAssets("stop/restart: 125 + 100 BPM at master 110", async () => {
    console.log("\n=== 125 + 100 BPM, master=110, stop ===");
    await runSyncResumeTest({
      file1: BEAT_125,
      bpm1: 125,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 110,
      pauseIntervals: [350, 700, 1100, 1400],
      mode: "stop",
    });
  });
});
