/**
 * sync-orchestration.test.ts — Replicates the EXACT syncPlay.ts frontend logic
 * using RPC calls. Tests whether the orchestration (which sync path is chosen,
 * buildScheduledBeatSyncPlan vs buildSyncStartPlan, immediateBeatSync vs
 * scheduleSyncPlay) causes sync to break on resume.
 *
 * This is NOT about testing the C library — it's about testing the TS decision
 * logic that sits between the user pressing play and the C sync function being called.
 */
import { beforeAll, describe, test, expect, setDefaultTimeout } from "bun:test";
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

// --- Constants matching syncPlay.ts ---
const IMMEDIATE_BEAT_SYNC_MIN_WINDOW_SEC = 0.15;
const IMMEDIATE_BEAT_SYNC_MIN_PREROLL_SEC = 0.02;

// --- Phase measurement helpers ---

function outputBarPhase(
  filePos: number,
  fileBeatRef: number,
  bpm: number,
  masterBpm: number,
  barDur: number
): number {
  const tr = bpm / masterBpm;
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

type SyncPath =
  | "immediateBeatSync"
  | "scheduledBeatSync"
  | "syncStartFallback"
  | "fallbackPlay"
  | "noSyncNeeded";

interface SyncResult {
  path: SyncPath;
  sourceBeat?: number;
  targetBeat?: number;
  barDuration?: number;
  scheduledPlanAvailable: boolean;
  shouldUseImmediateBeatSync?: boolean;
  secondsUntilSourceBeat?: number;
}

/**
 * Replicates syncPlay.ts logic exactly.
 * Returns which path was taken and sync parameters.
 */
async function replicateSyncPlay(
  client: ReturnType<typeof createCliRpcClient>,
  trackId: string,
  sourceId: string | null,
  tracks: Map<string, { beats: number[]; filePath: string; bpm: number }>,
  masterBpm: number,
  targetAnchorPos: number | null = null,
): Promise<SyncResult> {
  const target = tracks.get(trackId)!;
  const result: SyncResult = {
    path: "noSyncNeeded",
    scheduledPlanAvailable: false,
  };

  if (!sourceId) {
    // Fallback play — first track to play
    await client.request.play({ trackId });
    client.request.setMasterBpm({ bpm: masterBpm });
    client.request.alignGlobalClock({ trackId });
    result.path = "fallbackPlay";
    return result;
  }

  const source = tracks.get(sourceId)!;
  const sourceState = client.request.getPlaybackState({ trackId: sourceId });
  const targetState = client.request.getPlaybackState({ trackId: trackId });
  const sourcePos = sourceState.position;
  const targetPos = targetState.position;

  const syncPlanInput = {
    source: { beats: source.beats, filePath: source.filePath },
    target: { beats: target.beats, filePath: target.filePath },
    sourcePos,
    targetPos,
    targetAnchorPos,
    allowTransportPreserve: false,
  };

  // --- Try scheduled beat sync first (exactly like frontend) ---
  const scheduledPlan = buildScheduledBeatSyncPlan(syncPlanInput);
  result.scheduledPlanAvailable = scheduledPlan !== null;

  if (scheduledPlan) {
    const secondsUntilSourceBeat = scheduledPlan.sourceBeat - sourcePos;
    const availableTargetPreroll =
      scheduledPlan.targetBeat - Math.max(secondsUntilSourceBeat, 0);
    const immediateBeatSyncWindow = Math.max(
      IMMEDIATE_BEAT_SYNC_MIN_WINDOW_SEC,
      scheduledPlan.targetBeat - IMMEDIATE_BEAT_SYNC_MIN_PREROLL_SEC
    );
    const shouldUseImmediateBeatSync =
      secondsUntilSourceBeat >= 0 &&
      secondsUntilSourceBeat <= immediateBeatSyncWindow &&
      availableTargetPreroll >= IMMEDIATE_BEAT_SYNC_MIN_PREROLL_SEC;

    result.secondsUntilSourceBeat = secondsUntilSourceBeat;
    result.shouldUseImmediateBeatSync = shouldUseImmediateBeatSync;

    if (shouldUseImmediateBeatSync) {
      // immediateBeatSync path: uses syncStart with scheduled plan's beats
      const barDuration = getBarDuration(source.beats);
      result.path = "immediateBeatSync";
      result.sourceBeat = scheduledPlan.sourceBeat;
      result.targetBeat = scheduledPlan.targetBeat;
      result.barDuration = barDuration;

      const ok = await client.request.syncStart({
        targetTrackId: trackId,
        targetBeat: scheduledPlan.targetBeat,
        sourceTrackId: sourceId,
        sourceBeat: scheduledPlan.sourceBeat,
        barDuration,
        preserveTransport: false,
      });
      if (ok) return result;
    } else {
      // scheduledBeatSync path: uses scheduleSyncPlay
      result.path = "scheduledBeatSync";
      result.sourceBeat = scheduledPlan.sourceBeat;
      result.targetBeat = scheduledPlan.targetBeat;

      const ok = client.request.scheduleSyncPlay({
        targetTrackId: trackId,
        targetBeatSeconds: scheduledPlan.targetBeat,
        sourceTrackId: sourceId,
        sourceBeatSeconds: scheduledPlan.sourceBeat,
      });
      if (ok) return result;
    }
  }

  // --- Fallback: buildSyncStartPlan → syncStart ---
  const plan = buildSyncStartPlan(syncPlanInput);
  if (plan) {
    result.path = "syncStartFallback";
    result.sourceBeat = plan.sourceBeat;
    result.targetBeat = plan.targetBeat;
    result.barDuration = plan.barDuration;

    await client.request.syncStart({
      targetTrackId: trackId,
      targetBeat: plan.targetBeat,
      sourceTrackId: sourceId,
      sourceBeat: plan.sourceBeat,
      barDuration: plan.barDuration,
      preserveTransport: false,
    });
    return result;
  }

  return result;
}

// ==========================================================

describe("syncPlay orchestration (exact frontend replica)", () => {
  async function runOrchestrationTest(opts: {
    file1: string;
    bpm1: number;
    file2: string;
    bpm2: number;
    masterBpm: number;
    pauseIntervals: number[];
  }) {
    const { file1, bpm1, file2, bpm2, masterBpm, pauseIntervals } = opts;
    const outputBarDur = (4 * 60) / masterBpm;

    const client = createCliRpcClient();
    client.init();
    try {
      // Load tracks
      const source = await client.request.loadTrack({ filePath: file1 });
      const target = await client.request.loadTrack({ filePath: file2 });
      expect(source.beats.length).toBeGreaterThan(4);
      expect(target.beats.length).toBeGreaterThan(4);

      // Mute
      await client.request.setVolume({ trackId: source.id, volume: 0 });
      await client.request.setVolume({ trackId: target.id, volume: 0 });

      const trackMap = new Map([
        [source.id, { beats: source.beats, filePath: source.filePath, bpm: bpm1 }],
        [target.id, { beats: target.beats, filePath: target.filePath, bpm: bpm2 }],
      ]);

      console.log(
        `\n=== Orchestration: ${bpm1}+${bpm2} BPM master=${masterBpm} ===`
      );

      // === Step 1: Play track 1 (syncPlay with no source = fallback play) ===
      const r1 = await replicateSyncPlay(
        client, source.id, null, trackMap, masterBpm
      );
      console.log(`  [track1] path=${r1.path}`);
      expect(r1.path).toBe("fallbackPlay");
      await sleep(500);

      // === Step 2: Sync track 2 (syncPlay with track 1 as source) ===
      const r2 = await replicateSyncPlay(
        client, target.id, source.id, trackMap, masterBpm
      );
      console.log(
        `  [track2 initial] path=${r2.path} ` +
          `scheduledPlan=${r2.scheduledPlanAvailable} ` +
          `immediateBeat=${r2.shouldUseImmediateBeatSync ?? "N/A"} ` +
          `sourceBeat=${r2.sourceBeat?.toFixed(3)} ` +
          `targetBeat=${r2.targetBeat?.toFixed(3)} ` +
          `secUntilSrc=${r2.secondsUntilSourceBeat?.toFixed(3) ?? "N/A"}`
      );
      await sleep(300);

      // Verify initial sync
      const initS = client.request.getPlaybackState({ trackId: source.id });
      const initT = client.request.getPlaybackState({ trackId: target.id });
      const initSP = outputBarPhase(initS.position, source.beats[0]!, bpm1, masterBpm, outputBarDur);
      const initTP = outputBarPhase(initT.position, target.beats[0]!, bpm2, masterBpm, outputBarDur);
      const initDiff = phaseDiff(initSP, initTP, outputBarDur) * 1000;
      console.log(
        `  [initial sync] src=${initS.position.toFixed(3)} tgt=${initT.position.toFixed(3)} diff=${initDiff.toFixed(1)}ms`
      );
      expect(Math.abs(initDiff)).toBeLessThan(50);

      // === Step 3+: Pause/resume cycles ===
      const results: { interval: number; diffMs: number; path: SyncPath; syncResult: SyncResult }[] = [];

      for (const interval of pauseIntervals) {
        await sleep(interval);

        // Pause target (exact same as handlePause in PlaybackControls.tsx)
        await client.request.pause({ trackId: target.id });
        await sleep(100);

        // Resume target (exact same as handlePlay → syncPlay)
        const rResume = await replicateSyncPlay(
          client, target.id, source.id, trackMap, masterBpm
        );
        await sleep(300);

        // Measure phase alignment
        const ss = client.request.getPlaybackState({ trackId: source.id });
        const ts = client.request.getPlaybackState({ trackId: target.id });
        const sp = outputBarPhase(ss.position, source.beats[0]!, bpm1, masterBpm, outputBarDur);
        const tp = outputBarPhase(ts.position, target.beats[0]!, bpm2, masterBpm, outputBarDur);
        const diff = phaseDiff(sp, tp, outputBarDur) * 1000;

        results.push({ interval, diffMs: diff, path: rResume.path, syncResult: rResume });

        console.log(
          `  [resume after ${interval}ms] path=${rResume.path} ` +
            `scheduledPlan=${rResume.scheduledPlanAvailable} ` +
            `immediateBeat=${rResume.shouldUseImmediateBeatSync ?? "N/A"} ` +
            `sourceBeat=${rResume.sourceBeat?.toFixed(3)} ` +
            `targetBeat=${rResume.targetBeat?.toFixed(3)} ` +
            `secUntilSrc=${rResume.secondsUntilSourceBeat?.toFixed(3) ?? "N/A"} ` +
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

  testIfAssets("120+100 at master 120: exact syncPlay flow", async () => {
    await runOrchestrationTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 120,
      pauseIntervals: [500, 1000, 1500],
    });
  });

  testIfAssets("120+125 at master 122: exact syncPlay flow", async () => {
    await runOrchestrationTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_125,
      bpm2: 125,
      masterBpm: 122,
      pauseIntervals: [500, 1000, 1500],
    });
  });

  testIfAssets("120+120 at master 120: same BPM baseline", async () => {
    await runOrchestrationTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_120,
      bpm2: 120,
      masterBpm: 120,
      pauseIntervals: [500, 1000, 1500],
    });
  });

  // --- Tests that force scheduledBeatSync path on resume ---
  // These simulate having lockedPosition set to a beat (e.g., user clicked a cue)

  async function runAnchoredResumeTest(opts: {
    file1: string;
    bpm1: number;
    file2: string;
    bpm2: number;
    masterBpm: number;
    anchorBeatIndex: number; // which target beat to anchor to on resume
    label: string;
  }) {
    const { file1, bpm1, file2, bpm2, masterBpm, anchorBeatIndex, label } = opts;
    const outputBarDur = (4 * 60) / masterBpm;

    const client = createCliRpcClient();
    client.init();
    try {
      const source = await client.request.loadTrack({ filePath: file1 });
      const target = await client.request.loadTrack({ filePath: file2 });
      expect(source.beats.length).toBeGreaterThan(4);
      expect(target.beats.length).toBeGreaterThan(anchorBeatIndex);

      await client.request.setVolume({ trackId: source.id, volume: 0 });
      await client.request.setVolume({ trackId: target.id, volume: 0 });

      const trackMap = new Map([
        [source.id, { beats: source.beats, filePath: source.filePath, bpm: bpm1 }],
        [target.id, { beats: target.beats, filePath: target.filePath, bpm: bpm2 }],
      ]);

      console.log(`\n=== ${label} ===`);

      // Play track 1 (fallback play)
      await replicateSyncPlay(client, source.id, null, trackMap, masterBpm);
      await sleep(500);

      // Initial sync of track 2 (no anchor)
      const rInit = await replicateSyncPlay(
        client, target.id, source.id, trackMap, masterBpm
      );
      console.log(
        `  [initial] path=${rInit.path} sourceBeat=${rInit.sourceBeat?.toFixed(3)} ` +
          `targetBeat=${rInit.targetBeat?.toFixed(3)}`
      );
      await sleep(500);

      // Verify initial sync
      const initS = client.request.getPlaybackState({ trackId: source.id });
      const initT = client.request.getPlaybackState({ trackId: target.id });
      const initSP = outputBarPhase(initS.position, source.beats[0]!, bpm1, masterBpm, outputBarDur);
      const initTP = outputBarPhase(initT.position, target.beats[0]!, bpm2, masterBpm, outputBarDur);
      const initDiff = phaseDiff(initSP, initTP, outputBarDur) * 1000;
      console.log(`  [initial sync] diff=${initDiff.toFixed(1)}ms`);
      expect(Math.abs(initDiff)).toBeLessThan(50);

      // Pause target
      await client.request.pause({ trackId: target.id });
      await sleep(500);

      // Resume with targetAnchorPos set to a specific beat
      // This simulates lockedPosition being set (e.g., user clicked a cue or waveform)
      const anchorBeat = target.beats[anchorBeatIndex]!;
      const anchorPhaseIndex = anchorBeatIndex % 4;

      console.log(
        `  [anchor] beatIndex=${anchorBeatIndex} beat=${anchorBeat.toFixed(3)}s ` +
          `phaseIndex=${anchorPhaseIndex} (${anchorPhaseIndex === 0 ? "downbeat" : `beat ${anchorPhaseIndex + 1}`})`
      );

      const rResume = await replicateSyncPlay(
        client, target.id, source.id, trackMap, masterBpm, anchorBeat
      );
      await sleep(300);

      console.log(
        `  [resume] path=${rResume.path} ` +
          `scheduledPlan=${rResume.scheduledPlanAvailable} ` +
          `immediateBeat=${rResume.shouldUseImmediateBeatSync ?? "N/A"} ` +
          `sourceBeat=${rResume.sourceBeat?.toFixed(3)} ` +
          `targetBeat=${rResume.targetBeat?.toFixed(3)} ` +
          `secUntilSrc=${rResume.secondsUntilSourceBeat?.toFixed(3) ?? "N/A"}`
      );

      // Verify sync after resume
      const ss = client.request.getPlaybackState({ trackId: source.id });
      const ts = client.request.getPlaybackState({ trackId: target.id });
      const sp = outputBarPhase(ss.position, source.beats[0]!, bpm1, masterBpm, outputBarDur);
      const tp = outputBarPhase(ts.position, target.beats[0]!, bpm2, masterBpm, outputBarDur);
      const diff = phaseDiff(sp, tp, outputBarDur) * 1000;

      console.log(
        `  [result] src=${ss.position.toFixed(3)} tgt=${ts.position.toFixed(3)} diff=${diff.toFixed(1)}ms`
      );

      expect(Math.abs(diff)).toBeLessThan(50);
    } finally {
      client.shutdown();
    }
  }

  // Downbeat anchor (phaseIndex=0) — should use same source beat phase
  testIfAssets("anchored resume: downbeat anchor (120+100, beat 4)", async () => {
    await runAnchoredResumeTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 120,
      anchorBeatIndex: 4, // 5th beat = 2nd downbeat
      label: "Anchored downbeat: 120+100 master=120",
    });
  });

  // Non-downbeat anchor (phaseIndex=1) — source beat at different bar phase
  testIfAssets("anchored resume: non-downbeat anchor (120+100, beat 1)", async () => {
    await runAnchoredResumeTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 120,
      anchorBeatIndex: 1, // 2nd beat = phaseIndex 1
      label: "Anchored non-downbeat (beat 2): 120+100 master=120",
    });
  });

  // Non-downbeat anchor (phaseIndex=2) — another off-downbeat
  testIfAssets("anchored resume: non-downbeat anchor (120+100, beat 2)", async () => {
    await runAnchoredResumeTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 120,
      anchorBeatIndex: 2, // 3rd beat = phaseIndex 2
      label: "Anchored non-downbeat (beat 3): 120+100 master=120",
    });
  });

  // Non-downbeat anchor with different BPM combo
  testIfAssets("anchored resume: non-downbeat anchor (120+125, beat 1)", async () => {
    await runAnchoredResumeTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_125,
      bpm2: 125,
      masterBpm: 122,
      anchorBeatIndex: 1,
      label: "Anchored non-downbeat (beat 2): 120+125 master=122",
    });
  });

  // Non-downbeat anchor (phaseIndex=3) — beat 4 of bar
  testIfAssets("anchored resume: non-downbeat anchor (120+100, beat 3)", async () => {
    await runAnchoredResumeTest({
      file1: BEAT_120,
      bpm1: 120,
      file2: BEAT_100,
      bpm2: 100,
      masterBpm: 120,
      anchorBeatIndex: 3, // 4th beat = phaseIndex 3
      label: "Anchored non-downbeat (beat 4): 120+100 master=120",
    });
  });
});
