import { expect, test } from "bun:test";
import { buildSyncStartPlan } from "./syncPlan.ts";

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
