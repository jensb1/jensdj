/**
 * sync-app-flow.test.ts — Tests sync resume using the EXACT same code path
 * as the Electrobun app: RPC handlers → AudioEngine → FFI → C library.
 *
 * Replicates the user scenario:
 *   1. Press play on track 1 (sets master BPM, aligns global clock)
 *   2. Press play on track 2 (syncStart via buildSyncStartPlan)
 *   3. Pause track 2
 *   4. Wait ~1 second
 *   5. Press play on track 2 again → should re-sync
 *
 * Uses different BPM tracks to exercise tempo stretching.
 */
import { beforeAll, afterEach, describe, test, expect, setDefaultTimeout } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";

setDefaultTimeout(60000);

const ASSETS = resolve(import.meta.dir, "../test-assets");
const BEAT_100 = resolve(ASSETS, "beat100.mp3");
const BEAT_120 = resolve(ASSETS, "beat120.mp3");
const BEAT_125 = resolve(ASSETS, "beat125.mp3");

const assetsExist =
  existsSync(BEAT_100) && existsSync(BEAT_120) && existsSync(BEAT_125);
const testIfAssets = assetsExist ? test : test.skip;

let createCliRpcClient: typeof import("../src/bun/rpcCore.ts").createCliRpcClient;
let buildSyncStartPlan: typeof import("../src/shared/syncPlan.ts").buildSyncStartPlan;
let buildScheduledBeatSyncPlan: typeof import("../src/shared/syncPlan.ts").buildScheduledBeatSyncPlan;
let getBarDuration: typeof import("../src/shared/syncPlan.ts").getBarDuration;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  await Bun.$`cd native && zig build`.quiet();
  ({ createCliRpcClient } = await import("../src/bun/rpcCore.ts"));
  ({ buildSyncStartPlan, buildScheduledBeatSyncPlan, getBarDuration } =
    await import("../src/shared/syncPlan.ts"));
});

// --- Phase measurement helpers ---

/** Compute bar-phase in output-time for cross-BPM comparison */
function outputBarPhase(
  filePos: number,
  fileBeatRef: number,
  bpm: number,
  masterBpm: number,
  barDur: number
): number {
  const tr = bpm / masterBpm; // time_ratio: file-time → output-time
  let phase = (filePos * tr - fileBeatRef * tr) % barDur;
  if (phase < 0) phase += barDur;
  return phase;
}

function phaseDiff(phase1: number, phase2: number, barDur: number): number {
  let diff = phase1 - phase2;
  if (diff > barDur / 2) diff -= barDur;
  if (diff < -barDur / 2) diff += barDur;
  return diff;
}

// ==========================================================

describe("app-flow sync resume (RPC)", () => {
  /**
   * Replicates the exact app flow for sync:
   *   syncPlay(track1) → fallback play + setMasterBpm + alignGlobalClock
   *   syncPlay(track2) → buildSyncStartPlan + syncStart
   *   pause(track2)
   *   syncPlay(track2) → buildSyncStartPlan + syncStart (resume)
   */
  async function runAppFlowSyncTest(opts: {
    file1: string;
    bpm1: number;
    file2: string;
    bpm2: number;
    masterBpm: number;
    mode: "pause" | "stop";
    pauseIntervals: number[];
  }) {
    const { file1, bpm1, file2, bpm2, masterBpm, mode, pauseIntervals } = opts;
    const outputBarDur = (4 * 60) / masterBpm;

    const client = createCliRpcClient();
    client.init();
    try {
      // === Load tracks (exact same as app's loadTrack RPC) ===
      const source = await client.request.loadTrack({ filePath: file1 });
      const target = await client.request.loadTrack({ filePath: file2 });
      expect(source.beats.length).toBeGreaterThan(4);
      expect(target.beats.length).toBeGreaterThan(4);

      // Mute
      await client.request.setVolume({ trackId: source.id, volume: 0 });
      await client.request.setVolume({ trackId: target.id, volume: 0 });

      // === Step 1: Play track 1 (app's syncPlay fallback path) ===
      // App calls: play() → setMasterBpm() → alignGlobalClock()
      await client.request.play({ trackId: source.id });
      client.request.setMasterBpm({ bpm: masterBpm });
      client.request.alignGlobalClock({ trackId: source.id });
      await sleep(500);

      // === Step 2: Sync track 2 (app's syncPlay → syncStart path) ===
      const s0 = client.request.getPlaybackState({ trackId: source.id });
      const t0 = client.request.getPlaybackState({ trackId: target.id });
      const plan0 = buildSyncStartPlan({
        source: { beats: source.beats, filePath: source.filePath },
        target: { beats: target.beats, filePath: target.filePath },
        sourcePos: s0.position,
        targetPos: t0.position,
        allowTransportPreserve: false,
      });
      expect(plan0).not.toBeNull();

      await client.request.syncStart({
        targetTrackId: target.id,
        targetBeat: plan0!.targetBeat,
        sourceTrackId: source.id,
        sourceBeat: plan0!.sourceBeat,
        barDuration: plan0!.barDuration,
        preserveTransport: false,
      });
      await sleep(300);

      // Verify initial sync
      const initS = client.request.getPlaybackState({ trackId: source.id });
      const initT = client.request.getPlaybackState({ trackId: target.id });
      const initSP = outputBarPhase(initS.position, plan0!.sourceBeat, bpm1, masterBpm, outputBarDur);
      const initTP = outputBarPhase(initT.position, plan0!.targetBeat, bpm2, masterBpm, outputBarDur);
      const initDiff = phaseDiff(initSP, initTP, outputBarDur) * 1000;

      console.log(
        `\n=== ${bpm1}+${bpm2} BPM master=${masterBpm} ${mode} (RPC app flow) ===`
      );
      console.log(
        `  [initial] src=${initS.position.toFixed(3)} tgt=${initT.position.toFixed(3)} ` +
        `diff=${initDiff.toFixed(1)}ms`
      );
      expect(Math.abs(initDiff)).toBeLessThan(50);

      // === Step 3+4+5: Pause/resume cycles ===
      const results: { interval: number; diffMs: number }[] = [];

      for (const interval of pauseIntervals) {
        await sleep(interval);

        // Pause or stop target
        if (mode === "pause") {
          await client.request.pause({ trackId: target.id });
        } else {
          await client.request.stop({ trackId: target.id });
        }
        await sleep(100);

        // Re-build sync plan (exactly like the frontend syncPlay does)
        const ss = client.request.getPlaybackState({ trackId: source.id });
        const ts = client.request.getPlaybackState({ trackId: target.id });
        const plan = buildSyncStartPlan({
          source: { beats: source.beats, filePath: source.filePath },
          target: { beats: target.beats, filePath: target.filePath },
          sourcePos: ss.position,
          targetPos: ts.position,
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

        // Measure phase alignment
        const ssA = client.request.getPlaybackState({ trackId: source.id });
        const tsA = client.request.getPlaybackState({ trackId: target.id });
        const sp = outputBarPhase(ssA.position, plan!.sourceBeat, bpm1, masterBpm, outputBarDur);
        const tp = outputBarPhase(tsA.position, plan!.targetBeat, bpm2, masterBpm, outputBarDur);
        const diff = phaseDiff(sp, tp, outputBarDur) * 1000;
        results.push({ interval, diffMs: diff });

        console.log(
          `  [${mode} after ${interval}ms] src=${ssA.position.toFixed(3)} tgt=${tsA.position.toFixed(3)} ` +
          `diff=${diff.toFixed(1)}ms`
        );
      }

      // All resumes must be in sync
      for (const r of results) {
        expect(Math.abs(r.diffMs)).toBeLessThan(50);
      }
    } finally {
      client.shutdown();
    }
  }

  /**
   * Tests the cross-path scenario:
   *   Initial sync via scheduleSyncPlay (changes source beat_ref)
   *   Resume via syncStart (different C function, may not re-align clock)
   */
  async function runCrossPathSyncTest(opts: {
    file1: string;
    bpm1: number;
    file2: string;
    bpm2: number;
    masterBpm: number;
  }) {
    const { file1, bpm1, file2, bpm2, masterBpm } = opts;
    const outputBarDur = (4 * 60) / masterBpm;

    const client = createCliRpcClient();
    client.init();
    try {
      const source = await client.request.loadTrack({ filePath: file1 });
      const target = await client.request.loadTrack({ filePath: file2 });

      await client.request.setVolume({ trackId: source.id, volume: 0 });
      await client.request.setVolume({ trackId: target.id, volume: 0 });

      // Play source + set up global clock (app flow)
      await client.request.play({ trackId: source.id });
      client.request.setMasterBpm({ bpm: masterBpm });
      client.request.alignGlobalClock({ trackId: source.id });
      await sleep(500);

      // Initial sync via scheduleSyncPlay (uses different source beat than beats[0])
      const s0 = client.request.getPlaybackState({ trackId: source.id });
      const t0 = client.request.getPlaybackState({ trackId: target.id });
      const scheduledPlan = buildScheduledBeatSyncPlan({
        source: { beats: source.beats, filePath: source.filePath },
        target: { beats: target.beats, filePath: target.filePath },
        sourcePos: s0.position,
        targetPos: t0.position,
        allowTransportPreserve: false,
      });

      console.log(
        `\n=== Cross-path: ${bpm1}+${bpm2} BPM master=${masterBpm} ===`
      );

      if (!scheduledPlan) {
        // Fall back to syncStart if scheduled plan not available
        console.log("  (scheduledBeatSync not available, skipping cross-path test)");
        return;
      }

      console.log(
        `  scheduleSyncPlay: sourceBeat=${scheduledPlan.sourceBeat.toFixed(3)} ` +
        `targetBeat=${scheduledPlan.targetBeat.toFixed(3)}`
      );

      // Use scheduleSyncPlay for initial sync
      const schedOk = client.request.scheduleSyncPlay({
        targetTrackId: target.id,
        targetBeatSeconds: scheduledPlan.targetBeat,
        sourceTrackId: source.id,
        sourceBeatSeconds: scheduledPlan.sourceBeat,
      });
      expect(schedOk).toBe(true);
      await sleep(500);

      // Verify initial sync is good
      const initS = client.request.getPlaybackState({ trackId: source.id });
      const initT = client.request.getPlaybackState({ trackId: target.id });
      console.log(
        `  [initial] src=${initS.position.toFixed(3)} tgt=${initT.position.toFixed(3)}`
      );

      // Pause target
      await client.request.pause({ trackId: target.id });
      await sleep(1000);

      // Resume via syncStart (different C function than initial!)
      const ss = client.request.getPlaybackState({ trackId: source.id });
      const ts = client.request.getPlaybackState({ trackId: target.id });
      const plan = buildSyncStartPlan({
        source: { beats: source.beats, filePath: source.filePath },
        target: { beats: target.beats, filePath: target.filePath },
        sourcePos: ss.position,
        targetPos: ts.position,
        allowTransportPreserve: false,
      });
      expect(plan).not.toBeNull();

      console.log(
        `  syncStart resume: sourceBeat=${plan!.sourceBeat.toFixed(3)} ` +
        `targetBeat=${plan!.targetBeat.toFixed(3)} bar=${plan!.barDuration.toFixed(3)}`
      );

      await client.request.syncStart({
        targetTrackId: target.id,
        targetBeat: plan!.targetBeat,
        sourceTrackId: source.id,
        sourceBeat: plan!.sourceBeat,
        barDuration: plan!.barDuration,
        preserveTransport: false,
      });
      await sleep(300);

      // Verify sync after resume
      const ssA = client.request.getPlaybackState({ trackId: source.id });
      const tsA = client.request.getPlaybackState({ trackId: target.id });
      const sp = outputBarPhase(ssA.position, plan!.sourceBeat, bpm1, masterBpm, outputBarDur);
      const tp = outputBarPhase(tsA.position, plan!.targetBeat, bpm2, masterBpm, outputBarDur);
      const diff = phaseDiff(sp, tp, outputBarDur) * 1000;

      console.log(
        `  [resume] src=${ssA.position.toFixed(3)} tgt=${tsA.position.toFixed(3)} ` +
        `diff=${diff.toFixed(1)}ms`
      );

      expect(Math.abs(diff)).toBeLessThan(50);
    } finally {
      client.shutdown();
    }
  }

  // --- Same BPM (baseline, should always work) ---

  testIfAssets("pause/resume: same BPM (120+120 at master 120)", async () => {
    await runAppFlowSyncTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_120,
      bpm2: 120,
      masterBpm: 120,
      mode: "pause",
      pauseIntervals: [500, 1000, 1500],
    });
  });

  // --- Different BPMs (where the bug likely manifests) ---

  testIfAssets("pause/resume: 120+100 at master 120 (RPC app flow)", async () => {
    await runAppFlowSyncTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 120,
      mode: "pause",
      pauseIntervals: [500, 1000, 1500],
    });
  });

  testIfAssets("pause/resume: 120+125 at master 122 (RPC app flow)", async () => {
    await runAppFlowSyncTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_125,
      bpm2: 125,
      masterBpm: 122,
      mode: "pause",
      pauseIntervals: [500, 1000, 1500],
    });
  });

  testIfAssets("stop/restart: 120+100 at master 120 (RPC app flow)", async () => {
    await runAppFlowSyncTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 120,
      mode: "stop",
      pauseIntervals: [500, 1000, 1500],
    });
  });

  // --- Cross-path: initial scheduleSyncPlay → resume syncStart ---

  testIfAssets("cross-path: scheduleSyncPlay then syncStart resume", async () => {
    await runCrossPathSyncTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 120,
    });
  });
});
