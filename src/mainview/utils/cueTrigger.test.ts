import { expect, test } from "bun:test";
import { hasCrossedCue, shouldRearmCue } from "./cueTrigger.ts";

test("hasCrossedCue fires when playback crosses a cue going forward", () => {
  expect(hasCrossedCue(4.90, 5.02, 5.00)).toBe(true);
});

test("hasCrossedCue does not fire on backward transport jumps", () => {
  expect(hasCrossedCue(7.20, 4.80, 5.00)).toBe(false);
});

test("shouldRearmCue rearms once transport moves back before the cue", () => {
  expect(shouldRearmCue(4.70, 5.00)).toBe(true);
  expect(shouldRearmCue(4.95, 5.00)).toBe(false);
});
