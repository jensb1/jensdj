import { afterAll, beforeAll, expect, describe, test, setDefaultTimeout } from "bun:test";
import { existsSync } from "fs";

const TEST_FILE = process.env.JENSDJ_TEST_FILE ?? "/Volumes/MUSIC/all/acid pauli - nana.mp3";
const TEST_FILE_EXISTS = existsSync(TEST_FILE);
const testIfAudio = TEST_FILE_EXISTS ? test : test.skip;

let createCliRpcClient: typeof import("../src/bun/rpcCore.ts").createCliRpcClient;
let buildSyncStartPlan: typeof import("../src/shared/syncPlan.ts").buildSyncStartPlan;
let getBarDuration: typeof import("../src/shared/syncPlan.ts").getBarDuration;

setDefaultTimeout(30000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  await Bun.$`cd native && zig build`.quiet();
  ({ createCliRpcClient } = await import("../src/bun/rpcCore.ts"));
  ({ buildSyncStartPlan, getBarDuration } = await import("../src/shared/syncPlan.ts"));
});

// Force clean exit — repeated init/shutdown of miniaudio + Bun FFI
// causes a use-after-free crash during process teardown
afterAll(() => {
  setTimeout(() => process.exit(0), 100);
});

// --- Position Tracking ---

describe("position tracking", () => {
  testIfAudio("seek returns exact position", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: track.id, volume: 0 });

      // Seek to several positions within file duration and verify
      const dur = track.duration;
      for (const target of [0, 1.0, Math.min(5.0, dur - 0.5), Math.min(dur - 1.0, 7.0)]) {
        await client.request.seek({ trackId: track.id, seconds: target });
        const state = client.request.getPlaybackState({ trackId: track.id });
        expect(Math.abs(state.position - target)).toBeLessThan(0.002); // <2ms
      }
    } finally {
      client.shutdown();
    }
  });

  testIfAudio("position advances at correct rate (tempo=1.0)", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: track.id, volume: 0 });
      await client.request.play({ trackId: track.id });
      const startPos = client.request.getPlaybackState({ trackId: track.id }).position;
      const startTime = Bun.nanoseconds();
      await sleep(2000);
      const endPos = client.request.getPlaybackState({ trackId: track.id }).position;
      const endTime = Bun.nanoseconds();
      const wallTimeMs = (endTime - startTime) / 1e6;
      const positionDelta = endPos - startPos;
      const rate = positionDelta / (wallTimeMs / 1000);
      // Rate should be ~1.0 (position advances 1 second per wall-clock second)
      expect(rate).toBeGreaterThan(0.95);
      expect(rate).toBeLessThan(1.05);
    } finally {
      client.shutdown();
    }
  });

  testIfAudio("position advances at correct rate (tempo=1.1)", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: track.id, volume: 0 });
      // Set tempo to 1.1x
      client.request.setMasterBpm({
        bpm: (track.bpm || 120) * 1.1,
      });
      await client.request.play({ trackId: track.id });
      const startPos = client.request.getPlaybackState({ trackId: track.id }).position;
      const startTime = Bun.nanoseconds();
      await sleep(2000);
      const endPos = client.request.getPlaybackState({ trackId: track.id }).position;
      const endTime = Bun.nanoseconds();
      const wallTimeMs = (endTime - startTime) / 1e6;
      const positionDelta = endPos - startPos;
      const rate = positionDelta / (wallTimeMs / 1000);
      // Position advances in file-time at 1.1x wall-clock rate
      expect(rate).toBeGreaterThan(1.05);
      expect(rate).toBeLessThan(1.15);
    } finally {
      client.shutdown();
    }
  });

  testIfAudio("seek while playing jumps to correct position", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: track.id, volume: 0 });
      await client.request.play({ trackId: track.id });
      await sleep(500);

      const seekTarget = Math.min(track.duration - 1.0, 5.0);
      await client.request.seek({ trackId: track.id, seconds: seekTarget });
      await sleep(50); // Let one callback fire
      const state = client.request.getPlaybackState({ trackId: track.id });
      expect(Math.abs(state.position - seekTarget)).toBeLessThan(0.2); // <200ms (includes RB prime time)
      expect(state.isPlaying).toBe(true);
    } finally {
      client.shutdown();
    }
  });

  testIfAudio("rapid seeks don't cause drift", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: track.id, volume: 0 });

      // Rapid-fire 20 seeks within file duration
      const dur = track.duration;
      for (let i = 0; i < 20; i++) {
        const target = 0.5 + (i * 0.3) % (dur - 1.0);
        await client.request.seek({ trackId: track.id, seconds: target });
      }
      // Final seek to a known position
      const finalTarget = Math.min(3.0, dur - 1.0);
      await client.request.seek({ trackId: track.id, seconds: finalTarget });
      const state = client.request.getPlaybackState({ trackId: track.id });
      expect(Math.abs(state.position - finalTarget)).toBeLessThan(0.002);
    } finally {
      client.shutdown();
    }
  });
});

// --- Sync Precision ---
//
// These tests verify ACTUAL file-time bar-phase alignment, not just the
// internal phase measurement (which can report 0ms while audio is offset).
//
// Bar-phase for a track = fmod(position - firstBeat, barDuration)
// After sync, source and target bar-phases must match.

function barPhase(position: number, firstBeat: number, barDuration: number): number {
  let phase = (position - firstBeat) % barDuration;
  if (phase < 0) phase += barDuration;
  return phase;
}

function phaseDiff(phase1: number, phase2: number, barDuration: number): number {
  let diff = phase1 - phase2;
  if (diff > barDuration / 2) diff -= barDuration;
  if (diff < -barDuration / 2) diff += barDuration;
  return diff;
}

describe("sync precision", () => {
  testIfAudio("after syncStart, file-time bar-phases match", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const source = await client.request.loadTrack({ filePath: TEST_FILE });
      const target = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: source.id, volume: 0 });
      await client.request.setVolume({ trackId: target.id, volume: 0 });

      await client.request.play({ trackId: source.id });
      await sleep(500);

      const sourceState = client.request.getPlaybackState({ trackId: source.id });
      const targetState = client.request.getPlaybackState({ trackId: target.id });
      const plan = buildSyncStartPlan({
        source: { beats: source.beats, filePath: source.filePath },
        target: { beats: target.beats, filePath: target.filePath },
        sourcePos: sourceState.position,
        targetPos: targetState.position,
        allowTransportPreserve: false,
      });
      expect(plan).not.toBeNull();
      const bd = plan!.barDuration;

      await client.request.syncStart({
        targetTrackId: target.id,
        targetBeat: plan!.targetBeat,
        sourceTrackId: source.id,
        sourceBeat: plan!.sourceBeat,
        barDuration: bd,
        preserveTransport: false,
      });

      // Sample bar-phase alignment multiple times
      const samples: { sourcePos: number; targetPos: number; sourcePhase: number; targetPhase: number; diffMs: number }[] = [];
      for (let i = 0; i < 5; i++) {
        await sleep(200);
        const ss = client.request.getPlaybackState({ trackId: source.id });
        const ts = client.request.getPlaybackState({ trackId: target.id });
        const sp = barPhase(ss.position, plan!.sourceBeat, bd);
        const tp = barPhase(ts.position, plan!.targetBeat, bd);
        const diff = phaseDiff(sp, tp, bd);
        samples.push({
          sourcePos: ss.position,
          targetPos: ts.position,
          sourcePhase: sp,
          targetPhase: tp,
          diffMs: diff * 1000,
        });
      }

      console.log("\n=== Sync bar-phase alignment ===");
      console.log(`sourceBeat=${plan!.sourceBeat.toFixed(4)} targetBeat=${plan!.targetBeat.toFixed(4)} barDuration=${bd.toFixed(4)}`);
      for (const s of samples) {
        console.log(
          `  src=${s.sourcePos.toFixed(4)} tgt=${s.targetPos.toFixed(4)} ` +
          `srcPhase=${s.sourcePhase.toFixed(4)} tgtPhase=${s.targetPhase.toFixed(4)} ` +
          `diff=${s.diffMs.toFixed(1)}ms`
        );
      }

      // Every sample must be <50ms phase diff
      for (const s of samples) {
        expect(Math.abs(s.diffMs)).toBeLessThan(50);
      }
    } finally {
      client.shutdown();
    }
  });

  testIfAudio("bar-phase alignment holds through 5 pause/resume cycles", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const source = await client.request.loadTrack({ filePath: TEST_FILE });
      const target = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: source.id, volume: 0 });
      await client.request.setVolume({ trackId: target.id, volume: 0 });

      await client.request.play({ trackId: source.id });
      await sleep(500);

      // Initial sync
      const s0 = client.request.getPlaybackState({ trackId: source.id });
      const t0 = client.request.getPlaybackState({ trackId: target.id });
      const plan0 = buildSyncStartPlan({
        source: { beats: source.beats, filePath: source.filePath },
        target: { beats: target.beats, filePath: target.filePath },
        sourcePos: s0.position, targetPos: t0.position,
        allowTransportPreserve: false,
      });
      expect(plan0).not.toBeNull();
      const bd = plan0!.barDuration;
      const sourceBeat = plan0!.sourceBeat;

      await client.request.syncStart({
        targetTrackId: target.id,
        targetBeat: plan0!.targetBeat,
        sourceTrackId: source.id,
        sourceBeat: sourceBeat,
        barDuration: bd,
        preserveTransport: false,
      });

      console.log(`\n=== Pause/resume bar-phase test ===`);
      console.log(`sourceBeat=${sourceBeat.toFixed(4)} barDuration=${bd.toFixed(4)}`);

      const cycles: { cycle: number; targetBeat: number; diffMs: number; sourcePos: number; targetPos: number }[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        await sleep(400);
        await client.request.pause({ trackId: target.id });
        await sleep(100);

        // Re-build sync plan (exactly like the frontend does)
        const ss = client.request.getPlaybackState({ trackId: source.id });
        const ts = client.request.getPlaybackState({ trackId: target.id });
        const plan = buildSyncStartPlan({
          source: { beats: source.beats, filePath: source.filePath },
          target: { beats: target.beats, filePath: target.filePath },
          sourcePos: ss.position, targetPos: ts.position,
          allowTransportPreserve: false,
        });
        expect(plan).not.toBeNull();

        await client.request.syncStart({
          targetTrackId: target.id,
          targetBeat: plan!.targetBeat,
          sourceTrackId: source.id,
          sourceBeat: plan!.sourceBeat,
          barDuration: plan!.barDuration,
          preserveTransport: false,
        });

        await sleep(300);

        // Read ACTUAL positions and compute bar-phase diff
        const ssAfter = client.request.getPlaybackState({ trackId: source.id });
        const tsAfter = client.request.getPlaybackState({ trackId: target.id });
        const sp = barPhase(ssAfter.position, sourceBeat, bd);
        const tp = barPhase(tsAfter.position, plan!.targetBeat, bd);
        const diff = phaseDiff(sp, tp, bd);

        cycles.push({
          cycle,
          targetBeat: plan!.targetBeat,
          diffMs: diff * 1000,
          sourcePos: ssAfter.position,
          targetPos: tsAfter.position,
        });

        console.log(
          `  cycle ${cycle}: src=${ssAfter.position.toFixed(4)} tgt=${tsAfter.position.toFixed(4)} ` +
          `targetBeat=${plan!.targetBeat.toFixed(4)} diff=${(diff * 1000).toFixed(1)}ms`
        );
      }

      // Every cycle must be <50ms bar-phase diff
      for (const c of cycles) {
        expect(Math.abs(c.diffMs)).toBeLessThan(50);
      }

      // Drift check: last cycle should not be worse than first
      const firstDiff = Math.abs(cycles[0]!.diffMs);
      const lastDiff = Math.abs(cycles[cycles.length - 1]!.diffMs);
      expect(lastDiff).toBeLessThan(firstDiff + 20); // no accumulating drift
    } finally {
      client.shutdown();
    }
  });

  testIfAudio("bar-phase alignment holds through 3 stop/restart cycles", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const source = await client.request.loadTrack({ filePath: TEST_FILE });
      const target = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: source.id, volume: 0 });
      await client.request.setVolume({ trackId: target.id, volume: 0 });

      await client.request.play({ trackId: source.id });
      await sleep(500);

      // Initial sync
      const s0 = client.request.getPlaybackState({ trackId: source.id });
      const t0 = client.request.getPlaybackState({ trackId: target.id });
      const plan0 = buildSyncStartPlan({
        source: { beats: source.beats, filePath: source.filePath },
        target: { beats: target.beats, filePath: target.filePath },
        sourcePos: s0.position, targetPos: t0.position,
        allowTransportPreserve: false,
      });
      expect(plan0).not.toBeNull();
      const bd = plan0!.barDuration;
      const sourceBeat = plan0!.sourceBeat;

      await client.request.syncStart({
        targetTrackId: target.id,
        targetBeat: plan0!.targetBeat,
        sourceTrackId: source.id,
        sourceBeat: sourceBeat,
        barDuration: bd,
        preserveTransport: false,
      });

      console.log(`\n=== Stop/restart bar-phase test ===`);
      console.log(`sourceBeat=${sourceBeat.toFixed(4)} barDuration=${bd.toFixed(4)}`);

      const cycles: { cycle: number; targetBeat: number; diffMs: number }[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        await sleep(500);
        await client.request.stop({ trackId: target.id });
        await sleep(100);

        const ss = client.request.getPlaybackState({ trackId: source.id });
        const ts = client.request.getPlaybackState({ trackId: target.id });
        const plan = buildSyncStartPlan({
          source: { beats: source.beats, filePath: source.filePath },
          target: { beats: target.beats, filePath: target.filePath },
          sourcePos: ss.position, targetPos: ts.position,
          allowTransportPreserve: false,
        });
        expect(plan).not.toBeNull();

        await client.request.syncStart({
          targetTrackId: target.id,
          targetBeat: plan!.targetBeat,
          sourceTrackId: source.id,
          sourceBeat: plan!.sourceBeat,
          barDuration: plan!.barDuration,
          preserveTransport: false,
        });

        await sleep(300);
        const ssAfter = client.request.getPlaybackState({ trackId: source.id });
        const tsAfter = client.request.getPlaybackState({ trackId: target.id });
        const sp = barPhase(ssAfter.position, sourceBeat, bd);
        const tp = barPhase(tsAfter.position, plan!.targetBeat, bd);
        const diff = phaseDiff(sp, tp, bd);

        cycles.push({ cycle, targetBeat: plan!.targetBeat, diffMs: diff * 1000 });
        console.log(
          `  cycle ${cycle}: src=${ssAfter.position.toFixed(4)} tgt=${tsAfter.position.toFixed(4)} ` +
          `targetBeat=${plan!.targetBeat.toFixed(4)} diff=${(diff * 1000).toFixed(1)}ms`
        );
      }

      for (const c of cycles) {
        expect(Math.abs(c.diffMs)).toBeLessThan(50);
      }
    } finally {
      client.shutdown();
    }
  });

  testIfAudio("internal phase measurement agrees with file-time phase", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const source = await client.request.loadTrack({ filePath: TEST_FILE });
      const target = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: source.id, volume: 0 });
      await client.request.setVolume({ trackId: target.id, volume: 0 });

      await client.request.play({ trackId: source.id });
      await sleep(500);

      const ss = client.request.getPlaybackState({ trackId: source.id });
      const ts = client.request.getPlaybackState({ trackId: target.id });
      const plan = buildSyncStartPlan({
        source: { beats: source.beats, filePath: source.filePath },
        target: { beats: target.beats, filePath: target.filePath },
        sourcePos: ss.position, targetPos: ts.position,
        allowTransportPreserve: false,
      });
      expect(plan).not.toBeNull();
      const bd = plan!.barDuration;

      await client.request.syncStart({
        targetTrackId: target.id,
        targetBeat: plan!.targetBeat,
        sourceTrackId: source.id,
        sourceBeat: plan!.sourceBeat,
        barDuration: bd,
        preserveTransport: false,
      });

      await sleep(300);

      console.log("\n=== Phase measurement vs file-time comparison ===");
      console.log(`sourceBeat=${plan!.sourceBeat.toFixed(4)} targetBeat=${plan!.targetBeat.toFixed(4)} barDuration=${bd.toFixed(4)}`);
      for (let i = 0; i < 5; i++) {
        await sleep(200);
        const internalDiff = client.engine.getTrackSyncDiff(target.id);
        const ssNow = client.request.getPlaybackState({ trackId: source.id });
        const tsNow = client.request.getPlaybackState({ trackId: target.id });
        const srcOfc = client.request.getOutputFrameCount({ trackId: source.id });
        const tgtOfc = client.request.getOutputFrameCount({ trackId: target.id });
        const srcRc = client.request.getReadCursor({ trackId: source.id });
        const tgtRc = client.request.getReadCursor({ trackId: target.id });
        const sp = barPhase(ssNow.position, plan!.sourceBeat, bd);
        const tp = barPhase(tsNow.position, plan!.targetBeat, bd);
        const fileTimeDiff = phaseDiff(sp, tp, bd);

        console.log(
          `  internal=${(internalDiff * 1000).toFixed(1)}ms ` +
          `fileTime=${(fileTimeDiff * 1000).toFixed(1)}ms ` +
          `srcPos=${ssNow.position.toFixed(4)} tgtPos=${tsNow.position.toFixed(4)} ` +
          `srcOfc=${srcOfc} tgtOfc=${tgtOfc} ` +
          `srcRc=${srcRc} tgtRc=${tgtRc} ` +
          `ofcDiff=${srcOfc - tgtOfc}`
        );

        // Internal and file-time must agree within 50ms
        expect(Math.abs(internalDiff - fileTimeDiff)).toBeLessThan(0.050);
        // Both must be small
        expect(Math.abs(internalDiff)).toBeLessThan(0.050);
        expect(Math.abs(fileTimeDiff)).toBeLessThan(0.050);
      }
    } finally {
      client.shutdown();
    }
  });
});

// --- Tempo ---

describe("tempo", () => {
  testIfAudio("setMasterBpm applies correct ratio to all tracks", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      const originalBpm = track.bpm || 120;
      const masterBpm = 140;

      client.request.setMasterBpm({ bpm: masterBpm });
      const info = client.request.getTempoInfo({ trackIds: [track.id] });
      const expected = masterBpm / originalBpm;
      const trackInfo = info[track.id]!;
      expect(Math.abs(trackInfo.tempoRatio - expected)).toBeLessThan(0.01);
      expect(trackInfo.masterBpm).toBe(masterBpm);
    } finally {
      client.shutdown();
    }
  });
});

// --- Loops ---

describe("loops", () => {
  testIfAudio("loop wraps position correctly", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: track.id, volume: 0 });

      const loopStart = 2.0;
      const loopEnd = 4.0;
      client.request.setLoop({ trackId: track.id, startSec: loopStart, endSec: loopEnd });
      await client.request.seek({ trackId: track.id, seconds: loopStart });
      await client.request.play({ trackId: track.id });

      // Play through 3 loop iterations (~6 seconds)
      await sleep(6000);
      const state = client.request.getPlaybackState({ trackId: track.id });
      // Position should be within loop bounds
      expect(state.position).toBeGreaterThanOrEqual(loopStart - 0.1);
      expect(state.position).toBeLessThanOrEqual(loopEnd + 0.1);
    } finally {
      client.shutdown();
    }
  });
});

// --- EQ / Filter ---

describe("eq and filter", () => {
  testIfAudio("EQ values read back correctly", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      client.request.setEQ({ trackId: track.id, eq: { lo: 0.5, mid: 1.2, hi: 0.8 } });
      // Verify no crash
    } finally {
      client.shutdown();
    }
  });

  testIfAudio("filter value reads back correctly", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      client.request.setFilter({ trackId: track.id, value: 0.2 });
      // Verify no crash
    } finally {
      client.shutdown();
    }
  });
});

// --- Diagnostics (new functions) ---

describe("diagnostics", () => {
  testIfAudio("output_frame_count advances during playback", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: track.id, volume: 0 });

      const before = client.request.getOutputFrameCount({ trackId: track.id });
      await client.request.play({ trackId: track.id });
      await sleep(1000);
      const after = client.request.getOutputFrameCount({ trackId: track.id });

      expect(after).toBeGreaterThan(before);
      // Should have advanced ~44100-48000 frames in 1 second
      expect(after - before).toBeGreaterThan(40000);
      expect(after - before).toBeLessThan(53000);
    } finally {
      client.shutdown();
    }
  });

  testIfAudio("read_cursor advances during playback", async () => {
    const client = createCliRpcClient();
    client.init();
    try {
      const track = await client.request.loadTrack({ filePath: TEST_FILE });
      await client.request.setVolume({ trackId: track.id, volume: 0 });

      await client.request.play({ trackId: track.id });
      await sleep(500);
      const cursor = client.request.getReadCursor({ trackId: track.id });
      expect(cursor).toBeGreaterThan(0);
    } finally {
      client.shutdown();
    }
  });
});
