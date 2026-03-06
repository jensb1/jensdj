import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "path";

const ROOT = "/Users/jensberlips/Development/jensdj";
const APP_MACOS_DIR = join(ROOT, "build", "dev-macos-arm64", "JensDJ-dev.app", "Contents", "MacOS");
const APP_RESOURCES_DIR = join(ROOT, "build", "dev-macos-arm64", "JensDJ-dev.app", "Contents", "Resources");
const RUN_DESKTOP_E2E = process.env.JENSDJ_RUN_DESKTOP_E2E === "1";
const testIfDesktop = RUN_DESKTOP_E2E ? test : test.skip;

let appProcess: Bun.Subprocess | null = null;
let automationPort = 0;

setDefaultTimeout(60000);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 30000,
  intervalMs = 200
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function healthcheck(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${automationPort}/health`);
    if (!response.ok) return false;
    const body = await response.json() as { ok: boolean; ready?: boolean; hasWebview?: boolean };
    return body.ok && !!body.ready && !!body.hasWebview;
  } catch {
    return false;
  }
}

async function evaluate<T>(expression: string, timeoutMs = 15000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${automationPort}/eval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expression, timeoutMs }),
  });
  const body = await response.json() as { ok: boolean; value?: T; error?: string };
  if (!response.ok || !body.ok) {
    throw new Error(body.error ?? `Automation request failed with status ${response.status}`);
  }
  return body.value as T;
}

async function waitForSourceNearBar(trackId: string, mode: "before-next" | "after-current"): Promise<{
  backendPosition: number;
  nextDownbeat: number;
  previousDownbeat: number;
  firstBeat: number;
}> {
  let result: {
    backendPosition: number;
    nextDownbeat: number;
    previousDownbeat: number;
    firstBeat: number;
  } | null = null;

  await waitFor(async () => {
    result = await evaluate<{
      backendPosition: number;
      nextDownbeat: number;
      previousDownbeat: number;
      firstBeat: number;
    }>(`
      (async () => {
        const ctx = await window.__jensdjAutomation.getTrackContext([${JSON.stringify(trackId)}]);
        const track = ctx[${JSON.stringify(trackId)}];
        const beats = track.beats;
        let previousDownbeat = track.firstBeat;
        let nextDownbeat = beats[beats.length - 4] ?? track.firstBeat;
        for (let i = 0; i < beats.length; i += 4) {
          const beat = beats[i] ?? track.firstBeat;
          if (beat <= track.backendPosition + 0.0001) previousDownbeat = beat;
          if (beat > track.backendPosition + 0.0001) {
            nextDownbeat = beat;
            break;
          }
        }
        return {
          backendPosition: track.backendPosition,
          previousDownbeat,
          nextDownbeat,
          firstBeat: track.firstBeat,
        };
      })()
    `);

    if (!result) return false;
    const timeUntilNext = result.nextDownbeat - result.backendPosition;
    const timeSincePrevious = result.backendPosition - result.previousDownbeat;
    return mode === "before-next"
      ? timeUntilNext > 0.03 && timeUntilNext < 0.14
      : timeSincePrevious > 0.03 && timeSincePrevious < 0.14;
  }, 6000, 30);

  return result!;
}

beforeAll(async () => {
  if (!RUN_DESKTOP_E2E) return;

  automationPort = 47000 + Math.floor(Math.random() * 1000);
  await Bun.$`bun run build:css`.cwd(ROOT).quiet();
  await Bun.$`bun run build:dev`.cwd(ROOT).quiet();

  appProcess = Bun.spawn([join(APP_MACOS_DIR, "bun"), join(APP_RESOURCES_DIR, "main.js")], {
    cwd: APP_MACOS_DIR,
    env: {
      ...process.env,
      JENSDJ_AUTOMATION_PORT: String(automationPort),
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  await waitFor(healthcheck, 30000, 250);
  await waitFor(async () => {
    const trackIds = await evaluate<string[]>("window.__jensdjAutomation.getTrackIds()");
    return trackIds.length >= 2;
  }, 30000, 250);
});

afterAll(async () => {
  if (!appProcess) return;
  appProcess.kill();
  await appProcess.exited;
});

testIfDesktop("fresh deck 2 start does not snap to deck 1 transport", async () => {
  await evaluate(`
    (async () => {
      const snapshot = await window.__jensdjAutomation.getPlaybackSnapshot();
      for (const [trackId, track] of Object.entries(snapshot)) {
        if (!track.backendIsPlaying) continue;
        const stopButton = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stopButton instanceof HTMLElement) {
          stopButton.click();
        }
      }
      await window.__jensdjAutomation.sleep(300);
      return true;
    })()
  `);

  const initial = await evaluate<Record<string, {
    backendPosition: number;
    backendIsPlaying: boolean;
  }>>(`window.__jensdjAutomation.getPlaybackSnapshot(["track_1","track_2"])`);

  await evaluate(`window.__jensdjAutomation.clickByTestId("track-track_1-play")`);
  await evaluate(`window.__jensdjAutomation.sleep(2200)`);

  const beforeTrack2Start = await evaluate<Record<string, {
    backendPosition: number;
    backendIsPlaying: boolean;
    hasStartedPlayback: boolean;
  }>>(`window.__jensdjAutomation.getPlaybackSnapshot(["track_1","track_2"])`);

  await evaluate(`window.__jensdjAutomation.clickByTestId("track-track_2-play")`);
  await evaluate(`window.__jensdjAutomation.sleep(500)`);

  const afterTrack2Start = await evaluate<Record<string, {
    backendPosition: number;
    backendIsPlaying: boolean;
    hasStartedPlayback: boolean;
  }>>(`window.__jensdjAutomation.getPlaybackSnapshot(["track_1","track_2"])`);

  console.log("[DesktopE2E] initial", initial);
  console.log("[DesktopE2E] beforeTrack2Start", beforeTrack2Start);
  console.log("[DesktopE2E] afterTrack2Start", afterTrack2Start);

  expect(initial.track_2.backendIsPlaying).toBe(false);
  expect(beforeTrack2Start.track_2.backendIsPlaying).toBe(false);
  expect(afterTrack2Start.track_2.backendIsPlaying).toBe(true);
  expect(afterTrack2Start.track_2.hasStartedPlayback).toBe(true);
  expect(Math.abs(afterTrack2Start.track_1.backendPosition - afterTrack2Start.track_2.backendPosition)).toBeGreaterThan(0.5);
});

testIfDesktop("stopped deck 2 restart stays on its own parked transport", async () => {
  await evaluate(`
    (async () => {
      const ids = window.__jensdjAutomation.getTrackIds();
      for (const trackId of ids) {
        const stopButton = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stopButton instanceof HTMLElement) {
          stopButton.click();
        }
      }
      await window.__jensdjAutomation.sleep(300);
      return true;
    })()
  `);

  await evaluate(`window.__jensdjAutomation.clickByTestId("track-track_1-play")`);
  await evaluate(`window.__jensdjAutomation.sleep(2200)`);
  await evaluate(`window.__jensdjAutomation.clickByTestId("track-track_2-play")`);
  await evaluate(`window.__jensdjAutomation.sleep(500)`);

  const afterTrack2Start = await evaluate<Record<string, {
    backendPosition: number;
    backendIsPlaying: boolean;
  }>>(`window.__jensdjAutomation.getPlaybackSnapshot(["track_1","track_2"])`);

  console.log("[DesktopE2E] stopped-before-start", afterTrack2Start);

  expect(afterTrack2Start.track_2.backendIsPlaying).toBe(true);
  expect(Math.abs(afterTrack2Start.track_1.backendPosition - afterTrack2Start.track_2.backendPosition)).toBeGreaterThan(0.5);
});

testIfDesktop("bar-aligned track 2 start just before source next bar does not jump a full bar", async () => {
  await evaluate(`
    (async () => {
      const ids = window.__jensdjAutomation.getTrackIds();
      for (const trackId of ids) {
        const stopButton = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stopButton instanceof HTMLElement) {
          stopButton.click();
        }
      }
      await window.__jensdjAutomation.sleep(300);
      return true;
    })()
  `);

  await evaluate(`window.__jensdjAutomation.clickByTestId("track-track_1-play")`);
  const sourceAtTrigger = await waitForSourceNearBar("track_1", "before-next");
  await evaluate(`window.__jensdjAutomation.clickByTestId("track-track_2-play")`);
  await evaluate(`window.__jensdjAutomation.sleep(250)`);

  const afterTrack2Start = await evaluate<Record<string, {
    backendPosition: number;
    backendIsPlaying: boolean;
    firstBeat: number;
    beats: number[];
  }>>(`window.__jensdjAutomation.getTrackContext(["track_1","track_2"])`);

  const track2 = afterTrack2Start.track_2;
  console.log("[DesktopE2E] before-next-bar", {
    sourceAtTrigger,
    track1: afterTrack2Start.track_1,
    track2,
  });

  expect(track2.backendIsPlaying).toBe(true);
  expect(track2.backendPosition - track2.firstBeat).toBeLessThan(0.8);
});

testIfDesktop("track 2 parked on a later beat stays tightly synced when started just before source reaches that beat", async () => {
  await evaluate(`
    (async () => {
      const ids = window.__jensdjAutomation.getTrackIds();
      for (const trackId of ids) {
        const stopButton = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stopButton instanceof HTMLElement) {
          stopButton.click();
        }
      }
      await window.__jensdjAutomation.sleep(300);
      return true;
    })()
  `);

  const targetBeat = await evaluate<number>(`
    (async () => {
      const ctx = await window.__jensdjAutomation.getTrackContext(["track_2"]);
      const beat = ctx.track_2.beats[4];
      if (typeof beat !== "number") {
        throw new Error("Missing beat index 4 on track_2");
      }
      await window.djRpc.request.seek({ trackId: "track_2", seconds: beat });
      return beat;
    })()
  `);

  await evaluate(`window.__jensdjAutomation.clickByTestId("track-track_1-play")`);

  await waitFor(async () => {
    const ctx = await evaluate<Record<string, {
      backendPosition: number;
      backendIsPlaying: boolean;
      beats: number[];
    }>>(`window.__jensdjAutomation.getTrackContext(["track_1"])`);
    const sourceBeat = ctx.track_1.beats[4];
    const delta = sourceBeat - ctx.track_1.backendPosition;
    return delta > 0.02 && delta < 0.10;
  }, 6000, 20);

  await evaluate(`window.__jensdjAutomation.clickByTestId("track-track_2-play")`);
  await evaluate(`window.__jensdjAutomation.sleep(700)`);

  const afterStart = await evaluate<Record<string, {
    backendPosition: number;
    backendIsPlaying: boolean;
    beats: number[];
  }>>(`window.__jensdjAutomation.getTrackContext(["track_1","track_2"])`);

  const diffMs = Math.abs(afterStart.track_2.backendPosition - afterStart.track_1.backendPosition) * 1000;
  console.log("[DesktopE2E] parked-later-beat", {
    targetBeat,
    track1: afterStart.track_1,
    track2: afterStart.track_2,
    diffMs,
  });

  expect(afterStart.track_2.backendIsPlaying).toBe(true);
  expect(diffMs).toBeLessThan(20);
});

testIfDesktop("track 2 parked on a later beat stays tightly synced when started earlier in its lead-in", async () => {
  await evaluate(`
    (async () => {
      const ids = window.__jensdjAutomation.getTrackIds();
      for (const trackId of ids) {
        const stopButton = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stopButton instanceof HTMLElement) {
          stopButton.click();
        }
      }
      await window.__jensdjAutomation.sleep(300);
      return true;
    })()
  `);

  await evaluate(`
    (async () => {
      const ctx = await window.__jensdjAutomation.getTrackContext(["track_2"]);
      const beat = ctx.track_2.beats[4];
      if (typeof beat !== "number") {
        throw new Error("Missing beat index 4 on track_2");
      }
      await window.djRpc.request.seek({ trackId: "track_2", seconds: beat });
      return true;
    })()
  `);

  await evaluate(`window.__jensdjAutomation.clickByTestId("track-track_1-play")`);

  await waitFor(async () => {
    const ctx = await evaluate<Record<string, {
      backendPosition: number;
      beats: number[];
    }>>(`window.__jensdjAutomation.getTrackContext(["track_1"])`);
    const sourceBeat = ctx.track_1.beats[4];
    const delta = sourceBeat - ctx.track_1.backendPosition;
    return delta > 0.18 && delta < 0.35;
  }, 6000, 20);

  await evaluate(`window.__jensdjAutomation.clickByTestId("track-track_2-play")`);
  await evaluate(`window.__jensdjAutomation.sleep(900)`);

  const afterStart = await evaluate<Record<string, {
    backendPosition: number;
    backendIsPlaying: boolean;
    beats: number[];
  }>>(`window.__jensdjAutomation.getTrackContext(["track_1","track_2"])`);

  const diffMs = Math.abs(afterStart.track_2.backendPosition - afterStart.track_1.backendPosition) * 1000;
  console.log("[DesktopE2E] scheduled-later-beat", {
    track1: afterStart.track_1,
    track2: afterStart.track_2,
    diffMs,
  });

  expect(afterStart.track_2.backendIsPlaying).toBe(true);
  expect(diffMs).toBeLessThan(20);
});
