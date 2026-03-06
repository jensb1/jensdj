import { expect, test } from "bun:test";
import { buildCueSyncStartPlan, buildScheduledBeatSyncPlan, buildSyncStartPlan } from "./syncPlan.ts";

test("buildSyncStartPlan prefers target anchor position over backend target transport", () => {
  const beats = Array.from({ length: 20 }, (_, i) => i);
  const plan = buildSyncStartPlan({
    source: { beats, filePath: "source.mp3" },
    target: { beats, filePath: "target.mp3" },
    sourcePos: 5.2,
    targetPos: 0,
    targetAnchorPos: 13.1,
  });

  expect(plan).not.toBeNull();
  expect(plan?.targetBeat).toBe(12);
  expect(plan?.preserveTransport).toBe(false);
});

test("buildSyncStartPlan keeps transport-preserving restart when no target anchor is set", () => {
  const beats = Array.from({ length: 20 }, (_, i) => i);
  const plan = buildSyncStartPlan({
    source: { beats, filePath: "same.mp3" },
    target: { beats, filePath: "same.mp3" },
    sourcePos: 5.2,
    targetPos: 0,
  });

  expect(plan).not.toBeNull();
  expect(plan?.targetBeat).toBe(0);
  expect(plan?.preserveTransport).toBe(true);
});

test("buildSyncStartPlan does not preserve transport for a fresh deck start", () => {
  const beats = Array.from({ length: 20 }, (_, i) => i);
  const plan = buildSyncStartPlan({
    source: { beats, filePath: "same.mp3" },
    target: { beats, filePath: "same.mp3" },
    sourcePos: 5.2,
    targetPos: 0,
    allowTransportPreserve: false,
  });

  expect(plan).not.toBeNull();
  expect(plan?.targetBeat).toBe(0);
  expect(plan?.preserveTransport).toBe(false);
});

test("buildCueSyncStartPlan keeps connected cues aligned exactly cue-to-cue", () => {
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];
  const plan = buildCueSyncStartPlan({
    source: { beats, filePath: "source.mp3" },
    sourceCueTime: 3.5,
    targetCueTime: 11.25,
  });

  expect(plan).not.toBeNull();
  expect(plan?.sourceBeat).toBe(3.5);
  expect(plan?.targetBeat).toBe(11.25);
  expect(plan?.barDuration).toBe(2);
  expect(plan?.preserveTransport).toBe(false);
});

test("buildScheduledBeatSyncPlan chooses the upcoming source beat with matching phase when just before it", () => {
  const beats = [0.4, 0.9, 1.4, 1.9, 2.4, 2.9, 3.4, 3.9, 4.4, 4.9];
  const plan = buildScheduledBeatSyncPlan({
    source: { beats, filePath: "source.mp3" },
    target: { beats, filePath: "target.mp3" },
    sourcePos: 1.86,
    targetPos: 1.9,
  });

  expect(plan).not.toBeNull();
  expect(plan?.sourceBeat).toBe(1.9);
  expect(plan?.targetBeat).toBe(1.9);
});

test("buildScheduledBeatSyncPlan skips non-beat target anchors", () => {
  const beats = [0.4, 0.9, 1.4, 1.9, 2.4, 2.9, 3.4, 3.9, 4.4, 4.9];
  const plan = buildScheduledBeatSyncPlan({
    source: { beats, filePath: "source.mp3" },
    target: { beats, filePath: "target.mp3" },
    sourcePos: 2.33,
    targetPos: 1.05,
  });

  expect(plan).toBeNull();
});
