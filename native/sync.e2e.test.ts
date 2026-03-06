import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "fs";
import type { LoadedTrack } from "../src/shared/types.ts";
import type { SyncPlanInput, SyncStartPlan } from "../src/shared/syncPlan.ts";

const TEST_FILE = process.env.JENSDJ_TEST_FILE ?? "/Volumes/MUSIC/all/acid pauli - nana.mp3";
const TEST_FILE_EXISTS = existsSync(TEST_FILE);
const testIfAudio = TEST_FILE_EXISTS ? test : test.skip;

let createCliRpcClient: typeof import("../src/bun/rpcCore.ts").createCliRpcClient;
let buildLegacySyncStartPlan: typeof import("../src/shared/syncPlan.ts").buildLegacySyncStartPlan;
let buildSyncStartPlan: typeof import("../src/shared/syncPlan.ts").buildSyncStartPlan;

setDefaultTimeout(30000);

beforeAll(async () => {
  await Bun.$`make -C native`.quiet();
  ({ createCliRpcClient } = await import("../src/bun/rpcCore.ts"));
  ({ buildLegacySyncStartPlan, buildSyncStartPlan } = await import("../src/shared/syncPlan.ts"));
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncWithPlan(
  client: ReturnType<typeof createCliRpcClient>,
  source: LoadedTrack,
  target: LoadedTrack,
  buildPlan: (input: SyncPlanInput) => SyncStartPlan | null
): Promise<SyncStartPlan> {
  const sourceState = await client.request.getPlaybackState({ trackId: source.id });
  const targetState = await client.request.getPlaybackState({ trackId: target.id });
  const plan = buildPlan({
    source: { beats: source.beats, filePath: source.filePath },
    target: { beats: target.beats, filePath: target.filePath },
    sourcePos: sourceState.position,
    targetPos: targetState.position,
  });
  if (!plan) {
    throw new Error("Failed to build sync plan");
  }

  const ok = await client.request.syncStart({
    targetTrackId: target.id,
    targetBeat: plan.targetBeat,
    sourceTrackId: source.id,
    sourceBeat: plan.sourceBeat,
    barDuration: plan.barDuration,
    preserveTransport: plan.preserveTransport,
  });
  expect(ok).toBe(true);
  return plan;
}

async function runPauseResumeScenario(
  buildPlan: (input: SyncPlanInput) => SyncStartPlan | null
) {
  const client = createCliRpcClient();
  client.init();

  try {
    const source = await client.request.loadTrack({ filePath: TEST_FILE });
    const target = await client.request.loadTrack({ filePath: TEST_FILE });

    await client.request.setVolume({ trackId: source.id, volume: 0 });
    await client.request.setVolume({ trackId: target.id, volume: 0 });

    await client.request.play({ trackId: source.id });
    await sleep(1500);
    await syncWithPlan(client, source, target, buildSyncStartPlan);
    await sleep(500);

    const cycles: Array<{
      cycle: number;
      pausedPos: number;
      targetBeat: number;
      diffMs: number;
      playing: boolean;
    }> = [];

    for (let cycle = 0; cycle < 5; cycle++) {
      await sleep(900);
      await client.request.pause({ trackId: target.id });
      await sleep(100);

      const pausedTarget = await client.request.getPlaybackState({ trackId: target.id });
      const plan = buildPlan({
        source: { beats: source.beats, filePath: source.filePath },
        target: { beats: target.beats, filePath: target.filePath },
        sourcePos: (await client.request.getPlaybackState({ trackId: source.id })).position,
        targetPos: pausedTarget.position,
      });
      if (!plan) {
        throw new Error(`Failed to build sync plan for cycle ${cycle}`);
      }

      const ok = await client.request.syncStart({
        targetTrackId: target.id,
        targetBeat: plan.targetBeat,
        sourceTrackId: source.id,
        sourceBeat: plan.sourceBeat,
        barDuration: plan.barDuration,
        preserveTransport: plan.preserveTransport,
      });
      expect(ok).toBe(true);

      await sleep(250);
      const sourceAfter = await client.request.getPlaybackState({ trackId: source.id });
      const targetAfter = await client.request.getPlaybackState({ trackId: target.id });

      cycles.push({
        cycle,
        pausedPos: pausedTarget.position,
        targetBeat: plan.targetBeat,
        diffMs: (targetAfter.position - sourceAfter.position) * 1000,
        playing: targetAfter.isPlaying,
      });
    }

    return cycles;
  } finally {
    client.shutdown();
  }
}

async function runStopRestartScenario(
  buildPlan: (input: SyncPlanInput) => SyncStartPlan | null
) {
  const client = createCliRpcClient();
  client.init();

  try {
    const source = await client.request.loadTrack({ filePath: TEST_FILE });
    const target = await client.request.loadTrack({ filePath: TEST_FILE });

    await client.request.setVolume({ trackId: source.id, volume: 0 });
    await client.request.setVolume({ trackId: target.id, volume: 0 });

    await client.request.play({ trackId: source.id });
    await sleep(2000);

    const initialPlan = await syncWithPlan(client, source, target, buildPlan);
    await sleep(500);

    const cycles: Array<{
      cycle: number;
      targetPosBeforeStop: number;
      targetBeat: number;
      diffMs: number;
      playing: boolean;
      initialTargetBeat: number;
    }> = [];

    for (let cycle = 0; cycle < 4; cycle++) {
      await sleep(1200);
      const targetBeforeStop = await client.request.getPlaybackState({ trackId: target.id });
      await client.request.stop({ trackId: target.id });
      await sleep(150);

      const targetAfterStop = await client.request.getPlaybackState({ trackId: target.id });
      const sourceAfterStop = await client.request.getPlaybackState({ trackId: source.id });
      const plan = buildPlan({
        source: { beats: source.beats, filePath: source.filePath },
        target: { beats: target.beats, filePath: target.filePath },
        sourcePos: sourceAfterStop.position,
        targetPos: targetAfterStop.position,
      });
      if (!plan) {
        throw new Error(`Failed to build restart plan for cycle ${cycle}`);
      }

      const ok = await client.request.syncStart({
        targetTrackId: target.id,
        targetBeat: plan.targetBeat,
        sourceTrackId: source.id,
        sourceBeat: plan.sourceBeat,
        barDuration: plan.barDuration,
        preserveTransport: plan.preserveTransport,
      });
      expect(ok).toBe(true);

      await sleep(300);
      const sourceAfter = await client.request.getPlaybackState({ trackId: source.id });
      const targetAfter = await client.request.getPlaybackState({ trackId: target.id });

      cycles.push({
        cycle,
        targetPosBeforeStop: targetBeforeStop.position,
        targetBeat: plan.targetBeat,
        diffMs: (targetAfter.position - sourceAfter.position) * 1000,
        playing: targetAfter.isPlaying,
        initialTargetBeat: initialPlan.targetBeat,
      });
    }

    return cycles;
  } finally {
    client.shutdown();
  }
}

testIfAudio("legacy nearest-downbeat planning reproduces the pause/resume bug over RPC", async () => {
  const cycles = await runPauseResumeScenario(buildLegacySyncStartPlan);
  expect(cycles.some((cycle) => Math.abs(cycle.diffMs) > 1000)).toBe(true);
});

testIfAudio("current desktop RPC sync plan stays aligned through pause/resume", async () => {
  const cycles = await runPauseResumeScenario(buildSyncStartPlan);
  expect(cycles.every((cycle) => cycle.playing)).toBe(true);
  expect(cycles.every((cycle) => Math.abs(cycle.diffMs) < 100)).toBe(true);
});

testIfAudio("current desktop RPC sync plan stays aligned through stop/restart cycles", async () => {
  const cycles = await runStopRestartScenario(buildSyncStartPlan);
  expect(cycles.every((cycle) => cycle.playing)).toBe(true);
  expect(cycles.every((cycle) => Math.abs(cycle.diffMs) < 100)).toBe(true);
  expect(cycles.every((cycle) => cycle.targetBeat === cycle.initialTargetBeat)).toBe(true);
});
