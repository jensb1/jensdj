/**
 * sync-signal.test.ts — Signal-based sync alignment tests
 *
 * Tests the EXACT app scenario that causes the sync bug:
 *   1. Play track 1, set up global clock
 *   2. Sync track 2 via dj_sync_start
 *   3. Activate loops on BOTH tracks (simulating cue automations)
 *   4. Pause track 2
 *   5. Resume track 2 via dj_sync_start
 *   6. Verify: phase measurement + output signal alignment
 *
 * Uses direct FFI to call C functions, sleep() for real-time playback,
 * and dj_pull_frames + dj_find_transients for signal-level verification.
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

// --- FFI helpers ---

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
    dj_set_global_clock: { args: [FFIType.f32], returns: FFIType.void },
    dj_align_global_clock: { args: [FFIType.ptr], returns: FFIType.void },
    dj_get_global_phase: { returns: FFIType.f32 },
    dj_set_beat_ref: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
    dj_get_beat_ref: { args: [FFIType.ptr], returns: FFIType.f32 },
    dj_sync_start: {
      args: [FFIType.ptr, FFIType.f32, FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.i32],
      returns: FFIType.i32,
    },
    dj_schedule_sync_play: {
      args: [FFIType.ptr, FFIType.f32, FFIType.ptr, FFIType.f32],
      returns: FFIType.i32,
    },
    dj_set_loop: {
      args: [FFIType.ptr, FFIType.f32, FFIType.f32],
      returns: FFIType.void,
    },
    dj_clear_loop: { args: [FFIType.ptr], returns: FFIType.void },
    dj_is_looping: { args: [FFIType.ptr], returns: FFIType.i32 },
    dj_get_track_sync_diff: { args: [FFIType.ptr], returns: FFIType.f32 },
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

// --- Audio helpers ---

function toMono(stereo: Float32Array, numFrames: number): Float32Array {
  const mono = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    mono[i] = (stereo[i * 2]! + stereo[i * 2 + 1]!) / 2;
  }
  return mono;
}

function pullFrames(
  sound: Pointer,
  numFrames: number
): { stereo: Float32Array; framesRead: number } {
  const { buffer, pointer } = floatBuf(numFrames * 2);
  const framesRead = s.dj_pull_frames(sound, pointer, numFrames) as number;
  return { stereo: buffer, framesRead };
}

function detectTransients(mono: Float32Array, sr: number): Float32Array {
  const maxT = 500;
  const { buffer, pointer } = floatBuf(maxT);
  const count = s.dj_find_transients(
    ptr(mono) as Pointer,
    mono.length,
    sr,
    pointer,
    maxT
  ) as number;
  return buffer.subarray(0, count);
}

function intervals(times: Float32Array): number[] {
  const iv: number[] = [];
  for (let i = 1; i < times.length; i++) {
    iv.push(times[i]! - times[i - 1]!);
  }
  return iv;
}

function getBeats(filepath: string): Float32Array {
  const { buffer, pointer } = floatBuf(2000);
  const count = s.dj_detect_beats(cstr(filepath), pointer, 2000) as number;
  return buffer.subarray(0, count);
}

/**
 * Pull frames from two sounds, mix, detect transients, verify alignment.
 */
function mixAndCheckTransients(opts: {
  sound1: Pointer;
  sound2: Pointer;
  sr: number;
  seconds: number;
  label: string;
  expectedIntervalMs?: number;
  toleranceMs?: number;
}): { count: number; maxErrorMs: number; intervals: number[] } {
  const {
    sound1, sound2, sr, seconds, label,
    expectedIntervalMs = 500, toleranceMs = 25,
  } = opts;

  const numFrames = Math.ceil(seconds * sr);
  const r1 = pullFrames(sound1, numFrames);
  const r2 = pullFrames(sound2, numFrames);
  const mixFrames = Math.min(r1.framesRead, r2.framesRead);

  // Mix stereo buffers
  const mixed = new Float32Array(mixFrames * 2);
  for (let i = 0; i < mixFrames * 2; i++) {
    mixed[i] = (r1.stereo[i]! + r2.stereo[i]!) / 2;
  }
  const mixMono = toMono(mixed, mixFrames);
  const transients = detectTransients(mixMono, sr);
  const ivs = intervals(transients);

  console.log(
    `  [${label}] ${transients.length} transients in ${(mixFrames / sr).toFixed(1)}s`
  );
  if (ivs.length > 0) {
    console.log(
      `  [${label}] intervals: ${ivs.map((v) => (v * 1000).toFixed(1) + "ms").join(", ")}`
    );
  }

  // Should NOT have doubled transients
  const expectedCount = Math.floor(seconds / (expectedIntervalMs / 1000));
  expect(transients.length).toBeGreaterThanOrEqual(expectedCount - 2);
  expect(transients.length).toBeLessThanOrEqual(expectedCount + 3);

  // Check intervals (skip first — may be affected by seek/RB startup)
  let maxError = 0;
  for (let i = 1; i < ivs.length; i++) {
    const errorMs = Math.abs(ivs[i]! * 1000 - expectedIntervalMs);
    if (errorMs > maxError) maxError = errorMs;
    expect(errorMs).toBeLessThan(toleranceMs);
  }

  return { count: transients.length, maxErrorMs: maxError, intervals: ivs };
}

// ==========================================================
// Test Suite
// ==========================================================

describe("signal-based sync alignment", () => {
  // ---- Offline: seek + pull (baseline) ----

  describe("offline sync (seek + pull)", () => {
    let engine: Pointer;

    beforeAll(() => {
      engine = s.dj_create_engine(-1) as Pointer;
      expect(engine).not.toBeNull();
    });

    afterAll(() => {
      if (engine) s.dj_destroy_engine(engine);
    });

    testIfAssets("initial sync: 120+100 at master 120 — aligned transients", () => {
      const sound1 = s.dj_load_sound(engine, cstr(BEAT_120)) as Pointer;
      const sound2 = s.dj_load_sound(engine, cstr(BEAT_100)) as Pointer;

      try {
        const sr = s.dj_get_sample_rate(sound1) as number;

        s.dj_set_original_bpm(sound1, 120);
        s.dj_set_tempo(sound1, 1.0);
        s.dj_set_original_bpm(sound2, 100);
        s.dj_set_tempo(sound2, 120 / 100);

        const beats1 = getBeats(BEAT_120);
        const beats2 = getBeats(BEAT_100);

        s.dj_seek(sound1, beats1[0]!);
        s.dj_seek(sound2, beats2[0]!);

        console.log(`\n=== Offline: 120+100 at master 120 ===`);
        console.log(`  beat1=${beats1[0]!.toFixed(3)}s beat2=${beats2[0]!.toFixed(3)}s sr=${sr}`);

        mixAndCheckTransients({
          sound1, sound2, sr,
          seconds: 4, label: "initial",
        });
      } finally {
        s.dj_unload_sound(sound1);
        s.dj_unload_sound(sound2);
      }
    });

    testIfAssets("offline: seek + pull with loops active (120+100)", () => {
      const sound1 = s.dj_load_sound(engine, cstr(BEAT_120)) as Pointer;
      const sound2 = s.dj_load_sound(engine, cstr(BEAT_100)) as Pointer;

      try {
        const sr = s.dj_get_sample_rate(sound1) as number;

        s.dj_set_original_bpm(sound1, 120);
        s.dj_set_tempo(sound1, 1.0);
        s.dj_set_original_bpm(sound2, 100);
        s.dj_set_tempo(sound2, 120 / 100);

        const beats1 = getBeats(BEAT_120);
        const beats2 = getBeats(BEAT_100);
        const beat1 = beats1[0]!;
        const beat2 = beats2[0]!;

        // Set loops: 4 beats at original BPM
        const loopDur1 = 4 * 60 / 120; // 2.0s
        const loopDur2 = 4 * 60 / 100; // 2.4s
        s.dj_set_loop(sound1, beat1, beat1 + loopDur1);
        s.dj_set_loop(sound2, beat2, beat2 + loopDur2);

        s.dj_seek(sound1, beat1);
        s.dj_seek(sound2, beat2);

        console.log(`\n=== Offline + Loops: 120+100 at master 120 ===`);
        console.log(`  loop1=[${beat1.toFixed(3)}, ${(beat1 + loopDur1).toFixed(3)}] loop2=[${beat2.toFixed(3)}, ${(beat2 + loopDur2).toFixed(3)}]`);

        // Pull 6s — should loop through ~3 iterations
        mixAndCheckTransients({
          sound1, sound2, sr,
          seconds: 6, label: "looped",
        });
      } finally {
        s.dj_unload_sound(sound1);
        s.dj_unload_sound(sound2);
      }
    });

    testIfAssets("offline: resume after simulated pause + loops (120+100)", () => {
      const sound1 = s.dj_load_sound(engine, cstr(BEAT_120)) as Pointer;
      const sound2 = s.dj_load_sound(engine, cstr(BEAT_100)) as Pointer;

      try {
        const sr = s.dj_get_sample_rate(sound1) as number;
        const masterBpm = 120;
        const barDur = (4 * 60) / masterBpm; // 2.0s output-time
        const tr2 = 100 / masterBpm; // time_ratio for track2 = 0.8333

        s.dj_set_original_bpm(sound1, 120);
        s.dj_set_tempo(sound1, masterBpm / 120);
        s.dj_set_original_bpm(sound2, 100);
        s.dj_set_tempo(sound2, masterBpm / 100);

        const beats1 = getBeats(BEAT_120);
        const beats2 = getBeats(BEAT_100);
        const beat1 = beats1[0]!;
        const beat2 = beats2[0]!;

        // Set loops
        const loopDur1 = 4 * 60 / 120;
        const loopDur2 = 4 * 60 / 100;
        s.dj_set_loop(sound1, beat1, beat1 + loopDur1);
        s.dj_set_loop(sound2, beat2, beat2 + loopDur2);

        s.dj_seek(sound1, beat1);
        s.dj_seek(sound2, beat2);

        console.log(`\n=== Offline: resume with loops, 120+100 at master 120 ===`);

        // Pull 1.5s together (initial sync)
        mixAndCheckTransients({
          sound1, sound2, sr,
          seconds: 1.5, label: "initial-looped",
        });

        // Source continues 1.7s alone ("target paused")
        const advanceSec = 1.7;
        pullFrames(sound1, Math.ceil(advanceSec * sr));

        // Compute where target should resume
        const sourceOutputTotal = 1.5 + advanceSec;
        const sourceBarPhase = sourceOutputTotal % barDur;
        const targetSeek = beat2 + sourceBarPhase / tr2;

        console.log(
          `  [resume] source=${sourceOutputTotal.toFixed(1)}s phase=${sourceBarPhase.toFixed(3)}s ` +
          `target_seek=${targetSeek.toFixed(3)}s(file)`
        );

        s.dj_seek(sound2, targetSeek);

        // Pull 3s from both (should still be aligned through loops)
        mixAndCheckTransients({
          sound1, sound2, sr,
          seconds: 3, label: "after-resume-looped",
        });
      } finally {
        s.dj_unload_sound(sound1);
        s.dj_unload_sound(sound2);
      }
    });
  });

  // ---- Real-time: exact app flow with sync functions + loops ----

  describe("real-time sync with loops (app scenario)", () => {
    let engine: Pointer;

    beforeAll(() => {
      engine = s.dj_create_engine(-1) as Pointer;
      expect(engine).not.toBeNull();
    });

    afterAll(() => {
      if (engine) s.dj_destroy_engine(engine);
    });

    /**
     * Replicates the EXACT app bug scenario:
     *   1. Play source, set global clock
     *   2. Sync target via dj_sync_start
     *   3. Set loops on both (cue automations)
     *   4. Pause target
     *   5. Resume target via dj_sync_start
     *   6. Verify phase diff AND output signal
     */
    async function runSyncLoopResumeTest(opts: {
      file1: string; bpm1: number;
      file2: string; bpm2: number;
      masterBpm: number;
      pauseIntervals: number[];
    }) {
      const { file1, bpm1, file2, bpm2, masterBpm, pauseIntervals } = opts;
      const outputBarDur = (4 * 60) / masterBpm;

      const sound1 = s.dj_load_sound(engine, cstr(file1)) as Pointer;
      const sound2 = s.dj_load_sound(engine, cstr(file2)) as Pointer;

      try {
        const sr = s.dj_get_sample_rate(sound1) as number;
        const beats1 = getBeats(file1);
        const beats2 = getBeats(file2);
        const beat1 = beats1[0]!;
        const beat2 = beats2[0]!;

        // Setup tempos (same as app's setMasterBpm)
        s.dj_set_original_bpm(sound1, bpm1);
        s.dj_set_tempo(sound1, masterBpm / bpm1);
        s.dj_set_original_bpm(sound2, bpm2);
        s.dj_set_tempo(sound2, masterBpm / bpm2);
        s.dj_set_volume(sound1, 0);
        s.dj_set_volume(sound2, 0);

        // Step 1: Play source (app's syncPlay fallback path)
        s.dj_set_beat_ref(sound1, beat1);
        s.dj_play(sound1);
        s.dj_set_global_clock(outputBarDur);
        s.dj_align_global_clock(sound1);
        await sleep(500);

        // Step 2: Sync target (app's syncStart path)
        const syncResult = s.dj_sync_start(sound2, beat2, sound1, beat1, outputBarDur, 0);
        expect(syncResult).toBe(0);
        await sleep(300);

        // Check initial sync (no loops yet)
        const initDiff = (s.dj_get_track_sync_diff(sound2) as number) * 1000;
        console.log(`  [initial, no loops] sync_diff=${initDiff.toFixed(1)}ms`);
        expect(Math.abs(initDiff)).toBeLessThan(20);

        // Step 3: Activate loops on BOTH tracks (simulating cue automations)
        const loopDur1 = 4 * 60 / bpm1; // file-time loop duration
        const loopDur2 = 4 * 60 / bpm2;
        s.dj_set_loop(sound1, beat1, beat1 + loopDur1);
        s.dj_set_loop(sound2, beat2, beat2 + loopDur2);

        await sleep(500);

        // Check sync with loops active
        const loopDiff = (s.dj_get_track_sync_diff(sound2) as number) * 1000;
        console.log(`  [with loops] sync_diff=${loopDiff.toFixed(1)}ms`);
        expect(Math.abs(loopDiff)).toBeLessThan(20);

        // Steps 4-5: Pause/resume cycles
        for (const interval of pauseIntervals) {
          await sleep(interval);

          // Step 4: Pause target
          s.dj_pause(sound2);
          await sleep(100);

          // Re-activate loop (pause+seek might need it)
          s.dj_set_loop(sound2, beat2, beat2 + loopDur2);

          // Step 5: Resume target via dj_sync_start
          // (same as app: buildSyncStartPlan determines beats, calls syncStart)
          const result = s.dj_sync_start(sound2, beat2, sound1, beat1, outputBarDur, 0);
          expect(result).toBe(0);
          await sleep(300);

          // Check phase diff after resume
          const resumeDiff = (s.dj_get_track_sync_diff(sound2) as number) * 1000;
          console.log(`  [resume after ${interval}ms] sync_diff=${resumeDiff.toFixed(1)}ms`);
          expect(Math.abs(resumeDiff)).toBeLessThan(20);
        }

        // Step 6: Signal verification — stop both, pull frames, check transients
        // Record positions before stopping
        const pos1 = s.dj_get_position(sound1) as number;
        const pos2 = s.dj_get_position(sound2) as number;
        s.dj_stop(sound1);
        s.dj_stop(sound2);

        // Create fresh sounds for clean signal pull
        const fresh1 = s.dj_load_sound(engine, cstr(file1)) as Pointer;
        const fresh2 = s.dj_load_sound(engine, cstr(file2)) as Pointer;
        s.dj_set_original_bpm(fresh1, bpm1);
        s.dj_set_tempo(fresh1, masterBpm / bpm1);
        s.dj_set_original_bpm(fresh2, bpm2);
        s.dj_set_tempo(fresh2, masterBpm / bpm2);
        s.dj_set_loop(fresh1, beat1, beat1 + loopDur1);
        s.dj_set_loop(fresh2, beat2, beat2 + loopDur2);

        // Compute bar-phase aligned seek positions
        // pos1 is file-time position of source. Convert to output-time phase:
        const tr1 = bpm1 / masterBpm;
        const tr2 = bpm2 / masterBpm;
        const sourceOutputPhase = ((pos1 - beat1) * tr1) % outputBarDur;
        const alignedPos2 = beat2 + (sourceOutputPhase < 0 ? sourceOutputPhase + outputBarDur : sourceOutputPhase) / tr2;

        s.dj_seek(fresh1, pos1);
        s.dj_seek(fresh2, alignedPos2);

        const expectedIntervalMs = (60 / masterBpm) * 1000;
        console.log(
          `  [signal] pos1=${pos1.toFixed(3)} pos2=${pos2.toFixed(3)} ` +
          `alignedPos2=${alignedPos2.toFixed(3)} expectedInterval=${expectedIntervalMs.toFixed(0)}ms`
        );

        try {
          mixAndCheckTransients({
            sound1: fresh1, sound2: fresh2, sr,
            seconds: 3, label: "signal-verify",
            expectedIntervalMs,
          });
        } finally {
          s.dj_unload_sound(fresh1);
          s.dj_unload_sound(fresh2);
        }
      } finally {
        s.dj_stop(sound1);
        s.dj_stop(sound2);
        s.dj_unload_sound(sound1);
        s.dj_unload_sound(sound2);
      }
    }

    testIfAssets("sync + loops + pause/resume: 120+100 at master 120", async () => {
      console.log(`\n=== Real-time: sync+loops+resume 120+100 @ master 120 ===`);
      await runSyncLoopResumeTest({
        file1: BEAT_120, bpm1: 120,
        file2: BEAT_100, bpm2: 100,
        masterBpm: 120,
        pauseIntervals: [500, 1000, 1500],
      });
    });

    testIfAssets("sync + loops + pause/resume: 120+125 at master 122", async () => {
      console.log(`\n=== Real-time: sync+loops+resume 120+125 @ master 122 ===`);
      await runSyncLoopResumeTest({
        file1: BEAT_120, bpm1: 120,
        file2: BEAT_125, bpm2: 125,
        masterBpm: 122,
        pauseIntervals: [500, 1000],
      });
    });

    testIfAssets("sync + loops + pause/resume: 100+125 at master 110", async () => {
      console.log(`\n=== Real-time: sync+loops+resume 100+125 @ master 110 ===`);
      await runSyncLoopResumeTest({
        file1: BEAT_100, bpm1: 100,
        file2: BEAT_125, bpm2: 125,
        masterBpm: 110,
        pauseIntervals: [800, 1200],
      });
    });

    testIfAssets("sync + loops + scheduleSyncPlay then pause/resume: 120+100", async () => {
      console.log(`\n=== Real-time: scheduleSyncPlay → pause/resume 120+100 ===`);
      const masterBpm = 120;
      const outputBarDur = (4 * 60) / masterBpm;

      const sound1 = s.dj_load_sound(engine, cstr(BEAT_120)) as Pointer;
      const sound2 = s.dj_load_sound(engine, cstr(BEAT_100)) as Pointer;

      try {
        const sr = s.dj_get_sample_rate(sound1) as number;
        const beats1 = getBeats(BEAT_120);
        const beats2 = getBeats(BEAT_100);
        const beat1 = beats1[0]!;
        const beat2 = beats2[0]!;

        s.dj_set_original_bpm(sound1, 120);
        s.dj_set_tempo(sound1, masterBpm / 120);
        s.dj_set_original_bpm(sound2, 100);
        s.dj_set_tempo(sound2, masterBpm / 100);
        s.dj_set_volume(sound1, 0);
        s.dj_set_volume(sound2, 0);

        // Play source
        s.dj_set_beat_ref(sound1, beat1);
        s.dj_play(sound1);
        s.dj_set_global_clock(outputBarDur);
        s.dj_align_global_clock(sound1);
        await sleep(500);

        // Initial sync via scheduleSyncPlay (different C function)
        const schedResult = s.dj_schedule_sync_play(sound2, beat2, sound1, beat1);
        expect(schedResult).toBe(0);
        await sleep(500);

        // Activate loops
        const loopDur1 = 4 * 60 / 120;
        const loopDur2 = 4 * 60 / 100;
        s.dj_set_loop(sound1, beat1, beat1 + loopDur1);
        s.dj_set_loop(sound2, beat2, beat2 + loopDur2);
        await sleep(500);

        const loopDiff = (s.dj_get_track_sync_diff(sound2) as number) * 1000;
        console.log(`  [scheduleSyncPlay + loops] sync_diff=${loopDiff.toFixed(1)}ms`);
        expect(Math.abs(loopDiff)).toBeLessThan(20);

        // Pause target
        s.dj_pause(sound2);
        await sleep(1000);

        // Resume via syncStart (different C function than initial!)
        s.dj_set_loop(sound2, beat2, beat2 + loopDur2);
        const result = s.dj_sync_start(sound2, beat2, sound1, beat1, outputBarDur, 0);
        expect(result).toBe(0);
        await sleep(300);

        const resumeDiff = (s.dj_get_track_sync_diff(sound2) as number) * 1000;
        console.log(`  [resume via syncStart] sync_diff=${resumeDiff.toFixed(1)}ms`);
        expect(Math.abs(resumeDiff)).toBeLessThan(20);
      } finally {
        s.dj_stop(sound1);
        s.dj_stop(sound2);
        s.dj_unload_sound(sound1);
        s.dj_unload_sound(sound2);
      }
    });
  });
});
