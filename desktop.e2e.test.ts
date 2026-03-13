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

async function waitForSourceOffBeat(trackId: string): Promise<{
  backendPosition: number;
  previousBeat: number;
  nextBeat: number;
  beatPhase: number;
}> {
  let result: {
    backendPosition: number;
    previousBeat: number;
    nextBeat: number;
    beatPhase: number;
  } | null = null;

  await waitFor(async () => {
    result = await evaluate<{
      backendPosition: number;
      previousBeat: number;
      nextBeat: number;
      beatPhase: number;
    }>(`
      (async () => {
        const ctx = await window.__jensdjAutomation.getTrackContext([${JSON.stringify(trackId)}]);
        const track = ctx[${JSON.stringify(trackId)}];
        const beats = track.beats;
        let previousBeat = beats[0] ?? track.firstBeat;
        let nextBeat = beats[1] ?? (previousBeat + 0.5);

        for (let i = 1; i < beats.length; i++) {
          const beat = beats[i] ?? previousBeat;
          if (beat <= track.backendPosition + 0.0001) {
            previousBeat = beat;
            continue;
          }
          nextBeat = beat;
          break;
        }

        if (nextBeat <= previousBeat) {
          const last = beats[beats.length - 1] ?? previousBeat;
          const prev = beats[beats.length - 2] ?? (last - 0.5);
          nextBeat = previousBeat + Math.max(0.0001, last - prev);
        }

        const span = Math.max(0.0001, nextBeat - previousBeat);
        const beatPhase = (track.backendPosition - previousBeat) / span;

        return {
          backendPosition: track.backendPosition,
          previousBeat,
          nextBeat,
          beatPhase,
        };
      })()
    `);

    if (!result) return false;
    return result.beatPhase > 0.35 && result.beatPhase < 0.65;
  }, 6000, 20);

  return result!;
}

async function getZoomedWaveformCorrelation(
  trackId1: string,
  trackId2: string,
): Promise<{ zeroLag: number; bestCorr: number; bestLagPx: number }> {
  return await evaluate<{ zeroLag: number; bestCorr: number; bestLagPx: number }>(`
    (() => {
      const getVector = (trackId) => {
        const row = document.querySelector(\`[data-testid="track-row-\${trackId}"]\`);
        if (!(row instanceof HTMLElement)) {
          throw new Error(\`Missing row for \${trackId}\`);
        }
        const canvas = row.querySelectorAll("canvas")[0];
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error(\`Missing zoomed waveform canvas for \${trackId}\`);
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error(\`Missing 2d context for \${trackId}\`);
        }

        const dpr = window.devicePixelRatio || 1;
        const width = Math.round(canvas.width / dpr);
        const height = Math.round(canvas.height / dpr);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const centerX = Math.round(width / 2);
        const startX = Math.max(0, centerX - 220);
        const endX = Math.min(width - 1, centerX + 220);
        const startY = Math.floor(height * 0.18);
        const endY = Math.floor(height * 0.92);
        const vector = [];

        for (let x = startX; x <= endX; x++) {
          if (Math.abs(x - centerX) <= 2) {
            vector.push(0);
            continue;
          }

          let total = 0;
          for (let y = startY; y < endY; y++) {
            const idx = ((Math.floor(y * dpr) * canvas.width) + Math.floor(x * dpr)) * 4;
            const r = image[idx] ?? 0;
            const g = image[idx + 1] ?? 0;
            const b = image[idx + 2] ?? 0;
            const a = image[idx + 3] ?? 0;
            total += (r + g + b) * (a / 255);
          }
          vector.push(total);
        }

        const mean = vector.reduce((sum, value) => sum + value, 0) / vector.length;
        const centered = vector.map((value) => value - mean);
        const norm = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0)) || 1;
        return centered.map((value) => value / norm);
      };

      const a = getVector(${JSON.stringify(trackId1)});
      const b = getVector(${JSON.stringify(trackId2)});
      const correlationAtLag = (lag) => {
        let sum = 0;
        let count = 0;
        for (let i = 0; i < a.length; i++) {
          const j = i + lag;
          if (j < 0 || j >= b.length) continue;
          sum += a[i] * b[j];
          count += 1;
        }
        return count > 0 ? sum / count : -1;
      };

      let bestLagPx = 0;
      let bestCorr = -Infinity;
      for (let lag = -80; lag <= 80; lag++) {
        const corr = correlationAtLag(lag);
        if (corr > bestCorr) {
          bestCorr = corr;
          bestLagPx = lag;
        }
      }

      return {
        zeroLag: correlationAtLag(0),
        bestCorr,
        bestLagPx,
      };
    })()
  `);
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

testIfDesktop("fresh sync keeps the rendered zoomed waveform aligned to the audio path", async () => {
  await evaluate(`
    (async () => {
      const snapshot = await window.__jensdjAutomation.getPlaybackSnapshot();
      for (const [trackId] of Object.entries(snapshot)) {
        const stop = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stop instanceof HTMLElement) stop.click();
      }
      await window.__jensdjAutomation.sleep(300);
      await window.djRpc.request.setMasterBpm({ bpm: 0 });
      return true;
    })()
  `);

  const trackIds = await evaluate<string[]>("window.__jensdjAutomation.getTrackIds()");
  expect(trackIds.length).toBeGreaterThanOrEqual(2);
  const t1 = trackIds[0]!;
  const t2 = trackIds[1]!;

  await evaluate(`
    window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(t1)});
    window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(t2)});
  `);

  const ctx = await evaluate<Record<string, { beats: number[] }>>(`
    window.__jensdjAutomation.getTrackContext([${JSON.stringify(t1)}, ${JSON.stringify(t2)}])
  `);
  const beats1 = ctx[t1]!.beats;
  expect(beats1.length).toBeGreaterThan(4);
  const barDuration = (beats1[1]! - beats1[0]!) * 4;

  await evaluate(`window.__jensdjAutomation.clickByTestId("track-${t1}-play")`);
  const offBeat = await waitForSourceOffBeat(t1);
  console.log("[WaveformSyncE2E] source off-beat start", offBeat);
  await evaluate(`window.__jensdjAutomation.clickByTestId("track-${t2}-play")`);
  await sleep(500);

  const syncDiff = await evaluate<number>(`
    window.__jensdjAutomation.getSyncDiff(${JSON.stringify(t1)}, ${JSON.stringify(t2)}, 0, ${barDuration})
  `);
  const correlation = await getZoomedWaveformCorrelation(t1, t2);

  console.log(`[WaveformSyncE2E] syncDiff=${(syncDiff * 1000).toFixed(3)}ms`);
  console.log("[WaveformSyncE2E] correlation", correlation);

  expect(Math.abs(syncDiff)).toBeLessThan(0.02);
  expect(Math.abs(correlation.bestLagPx)).toBeLessThan(8);

  await evaluate(`
    (async () => {
      const stop1 = document.querySelector('[data-testid="track-${t1}-stop"]');
      const stop2 = document.querySelector('[data-testid="track-${t2}-stop"]');
      if (stop1 instanceof HTMLElement) stop1.click();
      if (stop2 instanceof HTMLElement) stop2.click();
      await window.__jensdjAutomation.sleep(300);
      return true;
    })()
  `);
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

testIfDesktop("cue point placed at preview position, not beginning", async () => {
  // Stop all tracks first
  await evaluate(`
    (async () => {
      const snapshot = await window.__jensdjAutomation.getPlaybackSnapshot();
      for (const [trackId] of Object.entries(snapshot)) {
        const stopButton = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stopButton instanceof HTMLElement) stopButton.click();
      }
      await window.__jensdjAutomation.sleep(300);
      return true;
    })()
  `);

  const trackIds = await evaluate<string[]>("window.__jensdjAutomation.getTrackIds()");
  const trackId = trackIds[0]!;

  // Get track beats to find a good position (~30 seconds in)
  const ctx = await evaluate<Record<string, {
    beats: number[];
    firstBeat: number;
  }>>(`window.__jensdjAutomation.getTrackContext([${JSON.stringify(trackId)}])`);
  const trackCtx = ctx[trackId]!;
  const targetBeat = trackCtx.beats.find((b: number) => b >= 30) ?? trackCtx.beats[Math.floor(trackCtx.beats.length / 2)]!;

  console.log("[CueE2E] Using trackId:", trackId, "targetBeat:", targetBeat);

  // Step 1: Select the track and set a preview/locked position at ~30s
  await evaluate(`
    window.__jensdjAutomation.setSelectedTrack(${JSON.stringify(trackId)});
    window.__jensdjAutomation.setLockedPosition(${JSON.stringify(trackId)}, ${targetBeat});
  `);

  // Verify store state after setting locked position
  const stateAfterLock = await evaluate<{
    trackId: string | null;
    lockedPosition: number | null;
    previewPosition: number | null;
    position: number;
  }>("window.__jensdjAutomation.getSelectedTrackState()");

  console.log("[CueE2E] State after lock:", stateAfterLock);
  expect(stateAfterLock.trackId).toBe(trackId);
  expect(stateAfterLock.lockedPosition).toBe(targetBeat);

  // Step 2: Add a cue at the locked position
  const addResult = await evaluate<{
    id: string; time: number; active: boolean; label: string;
  } | null>(`window.__jensdjAutomation.addOrToggleCue(${JSON.stringify(trackId)}, ${targetBeat})`);

  console.log("[CueE2E] addOrToggleCue result:", addResult);
  expect(addResult).not.toBeNull();
  expect(addResult!.label).toBe("A");
  expect(addResult!.active).toBe(false);

  // Step 3: Verify the cue was placed at the correct position (NOT at the beginning)
  const cueTimeDiff = Math.abs(addResult!.time - targetBeat);
  console.log("[CueE2E] cue time:", addResult!.time, "target:", targetBeat, "diff:", cueTimeDiff);
  // Cue should be snapped to nearest beat around targetBeat, not at the beginning
  expect(addResult!.time).toBeGreaterThan(10);
  expect(cueTimeDiff).toBeLessThan(2); // within 2 seconds (beat snapping)

  // Step 4: Verify cue shows up in the snapshot
  const cues = await evaluate<{
    id: string; time: number; active: boolean; label: string; filePath: string;
  }[]>(`window.__jensdjAutomation.getCueSnapshot(${JSON.stringify(trackId)})`);
  console.log("[CueE2E] cue snapshot:", cues);
  expect(cues.length).toBeGreaterThanOrEqual(1);
  expect(cues[0]!.time).toBeGreaterThan(10);
  expect(cues[0]!.active).toBe(false);

  // Step 5: Toggle cue to active by calling addOrToggleCue at the same position
  const toggleResult = await evaluate<{
    id: string; time: number; active: boolean; label: string;
  } | null>(`window.__jensdjAutomation.addOrToggleCue(${JSON.stringify(trackId)}, ${targetBeat})`);

  console.log("[CueE2E] toggle result:", toggleResult);
  expect(toggleResult).not.toBeNull();
  // After toggle, the cue should now be active
  const cuesAfterToggle = await evaluate<{
    id: string; time: number; active: boolean; label: string;
  }[]>(`window.__jensdjAutomation.getCueSnapshot(${JSON.stringify(trackId)})`);
  const toggledCue = cuesAfterToggle.find(c => Math.abs(c.time - addResult!.time) < 0.1);
  console.log("[CueE2E] cue after toggle:", toggledCue);
  expect(toggledCue).toBeDefined();
  expect(toggledCue!.active).toBe(true);

  // Step 6: Verify clicking cue in table jumps to correct position
  // First reset locked position to 0
  await evaluate(`
    window.__jensdjAutomation.setLockedPosition(${JSON.stringify(trackId)}, 0);
  `);
  await evaluate(`window.__jensdjAutomation.sleep(100)`);

  const stateReset = await evaluate<{
    lockedPosition: number | null;
  }>("window.__jensdjAutomation.getSelectedTrackState()");
  expect(stateReset.lockedPosition).toBe(0);

  // Simulate CueTable row click: set locked + preview to cue time
  await evaluate(`
    window.__jensdjAutomation.setLockedPosition(${JSON.stringify(trackId)}, ${addResult!.time});
  `);

  const stateAfterCueClick = await evaluate<{
    lockedPosition: number | null;
    previewPosition: number | null;
  }>("window.__jensdjAutomation.getSelectedTrackState()");
  console.log("[CueE2E] state after cue click:", stateAfterCueClick);
  expect(stateAfterCueClick.lockedPosition).toBe(addResult!.time);
  expect(stateAfterCueClick.previewPosition).toBe(addResult!.time);
});

testIfDesktop("active cue connection fires when playback crosses cue point", async () => {
  // Stop all tracks and clean up cues
  await evaluate(`
    (async () => {
      const snapshot = await window.__jensdjAutomation.getPlaybackSnapshot();
      for (const [trackId] of Object.entries(snapshot)) {
        const stop = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stop instanceof HTMLElement) stop.click();
      }
      await window.__jensdjAutomation.sleep(300);
      return true;
    })()
  `);

  const trackIds = await evaluate<string[]>("window.__jensdjAutomation.getTrackIds()");
  expect(trackIds.length).toBeGreaterThanOrEqual(2);
  const track1 = trackIds[0]!;
  const track2 = trackIds[1]!;

  // Clean up any existing cues
  await evaluate(`
    window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(track1)});
    window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(track2)});
  `);

  // Get beats to pick cue positions
  const ctx = await evaluate<Record<string, {
    beats: number[];
    firstBeat: number;
  }>>(`window.__jensdjAutomation.getTrackContext([${JSON.stringify(track1)}, ${JSON.stringify(track2)}])`);

  const t1Beats = ctx[track1]!.beats;
  const t2Beats = ctx[track2]!.beats;

  // Place source cue on track1 ~3 seconds in (close enough to reach quickly)
  const sourceBeatTime = t1Beats.find((b: number) => b >= 3) ?? t1Beats[6]!;
  // Place target cue on track2 at some position
  const targetBeatTime = t2Beats.find((b: number) => b >= 10) ?? t2Beats[20]!;

  console.log("[CueFireE2E] track1:", track1, "track2:", track2);
  console.log("[CueFireE2E] sourceBeatTime:", sourceBeatTime, "targetBeatTime:", targetBeatTime);

  // Step 1: Create cues on both tracks
  const sourceCue = await evaluate<{
    id: string; time: number; active: boolean; label: string;
  } | null>(`window.__jensdjAutomation.addOrToggleCue(${JSON.stringify(track1)}, ${sourceBeatTime})`);
  expect(sourceCue).not.toBeNull();

  const targetCue = await evaluate<{
    id: string; time: number; active: boolean; label: string;
  } | null>(`window.__jensdjAutomation.addOrToggleCue(${JSON.stringify(track2)}, ${targetBeatTime})`);
  expect(targetCue).not.toBeNull();

  console.log("[CueFireE2E] sourceCue:", sourceCue, "targetCue:", targetCue);

  // Step 2: Activate both cues
  await evaluate(`window.__jensdjAutomation.toggleCueActive(${JSON.stringify(sourceCue!.id)})`);
  await evaluate(`window.__jensdjAutomation.toggleCueActive(${JSON.stringify(targetCue!.id)})`);

  // Verify active
  const sourceDetail = await evaluate<{
    active: boolean; automations: { type: string; targetCueId?: string }[];
  } | null>(`window.__jensdjAutomation.getCueDetail(${JSON.stringify(sourceCue!.id)})`);
  expect(sourceDetail!.active).toBe(true);

  // Step 3: Connect source → target
  const connected = await evaluate<boolean>(`
    window.__jensdjAutomation.connectCues(${JSON.stringify(sourceCue!.id)}, ${JSON.stringify(targetCue!.id)})
  `);
  expect(connected).toBe(true);

  // Verify connection automation exists
  const sourceAfterConnect = await evaluate<{
    active: boolean;
    automations: { type: string; targetCueId?: string }[];
  } | null>(`window.__jensdjAutomation.getCueDetail(${JSON.stringify(sourceCue!.id)})`);
  console.log("[CueFireE2E] source after connect:", sourceAfterConnect);
  expect(sourceAfterConnect!.automations.length).toBe(1);
  expect(sourceAfterConnect!.automations[0]!.targetCueId).toBe(targetCue!.id);
  expect(sourceAfterConnect!.automations[0]!.type).toBe("connect");

  // Step 4: Verify track2 is NOT playing yet
  const beforePlay = await evaluate<Record<string, {
    backendIsPlaying: boolean;
    backendPosition: number;
  }>>(`window.__jensdjAutomation.getPlaybackSnapshot([${JSON.stringify(track1)}, ${JSON.stringify(track2)}])`);
  console.log("[CueFireE2E] before play:", beforePlay);
  expect(beforePlay[track2]!.backendIsPlaying).toBe(false);

  // Step 5: Start track1 from the beginning (before the cue)
  await evaluate(`
    window.__jensdjAutomation.clickByTestId("track-${track1}-play");
  `);

  // Step 6: Wait for playback to cross the cue point
  // The cue is at ~3 seconds, so wait up to 8 seconds
  let track2Started = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(200);
    const snap = await evaluate<Record<string, {
      backendIsPlaying: boolean;
      backendPosition: number;
    }>>(`window.__jensdjAutomation.getPlaybackSnapshot([${JSON.stringify(track1)}, ${JSON.stringify(track2)}])`);

    if (snap[track2]!.backendIsPlaying) {
      track2Started = true;
      console.log("[CueFireE2E] track2 started! track1 pos:", snap[track1]!.backendPosition,
        "track2 pos:", snap[track2]!.backendPosition);
      break;
    }
  }

  expect(track2Started).toBe(true);

  // Step 7: Verify track2 is near the target cue position
  const afterFire = await evaluate<Record<string, {
    backendIsPlaying: boolean;
    backendPosition: number;
  }>>(`window.__jensdjAutomation.getPlaybackSnapshot([${JSON.stringify(track1)}, ${JSON.stringify(track2)}])`);

  console.log("[CueFireE2E] after fire:", afterFire);
  expect(afterFire[track1]!.backendIsPlaying).toBe(true);
  expect(afterFire[track2]!.backendIsPlaying).toBe(true);
  // Track1 should have passed the source cue
  expect(afterFire[track1]!.backendPosition).toBeGreaterThan(sourceCue!.time - 0.5);

  // Clean up: stop both tracks and remove cues
  await evaluate(`
    (async () => {
      const stop1 = document.querySelector('[data-testid="track-${track1}-stop"]');
      const stop2 = document.querySelector('[data-testid="track-${track2}-stop"]');
      if (stop1 instanceof HTMLElement) stop1.click();
      if (stop2 instanceof HTMLElement) stop2.click();
      await window.__jensdjAutomation.sleep(300);
      window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(track1)});
      window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(track2)});
      return true;
    })()
  `);
});

testIfDesktop("EQ automation triggers and changes parameter value", async () => {
  // Stop all tracks first
  await evaluate(`
    (async () => {
      const snapshot = await window.__jensdjAutomation.getPlaybackSnapshot();
      for (const [trackId] of Object.entries(snapshot)) {
        const stop = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stop instanceof HTMLElement) stop.click();
      }
      await window.__jensdjAutomation.sleep(300);
      return true;
    })()
  `);

  const trackIds = await evaluate<string[]>("window.__jensdjAutomation.getTrackIds()");
  expect(trackIds.length).toBeGreaterThanOrEqual(1);
  const trackId = trackIds[0]!;

  // Clean up existing cues
  await evaluate(`window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(trackId)})`);

  // Get beats
  const ctx = await evaluate<Record<string, { beats: number[]; firstBeat: number }>>(`
    window.__jensdjAutomation.getTrackContext([${JSON.stringify(trackId)}])
  `);
  const beats = ctx[trackId]!.beats;
  // Place cue ~2 seconds in
  const cueTime = beats.find((b: number) => b >= 2) ?? beats[4]!;
  console.log("[EqAutoE2E] trackId:", trackId, "cueTime:", cueTime);

  // Create cue
  const cue = await evaluate<{ id: string; time: number } | null>(`
    window.__jensdjAutomation.addOrToggleCue(${JSON.stringify(trackId)}, ${cueTime})
  `);
  expect(cue).not.toBeNull();

  // Add EQ Lo automation: 1.0 → 0.0 over 2 bars (kill bass)
  const autoId = await evaluate<string | null>(`
    window.__jensdjAutomation.addCueAutomation(${JSON.stringify(cue!.id)}, "eq_lo", 2, 1.0, 0.0, "linear")
  `);
  expect(autoId).not.toBeNull();
  console.log("[EqAutoE2E] automation id:", autoId);

  // Activate cue
  await evaluate(`window.__jensdjAutomation.toggleCueActive(${JSON.stringify(cue!.id)})`);

  // Verify cue detail
  const detail = await evaluate<{
    active: boolean;
    automations: { id: string; type: string; durationBars: number }[];
  } | null>(`window.__jensdjAutomation.getCueDetail(${JSON.stringify(cue!.id)})`);
  console.log("[EqAutoE2E] cue detail:", detail);
  expect(detail!.active).toBe(true);
  expect(detail!.automations.length).toBe(1);
  expect(detail!.automations[0]!.type).toBe("eq_lo");

  // Check EQ LO automation is NOT active before playback
  const beforePlay = await evaluate<{ active: boolean; value: number }>(`
    window.__jensdjAutomation.getAutomationState(${JSON.stringify(trackId)}, 2)
  `);
  console.log("[EqAutoE2E] before play automation state:", beforePlay);
  expect(beforePlay.active).toBe(false);

  // Start playback
  await evaluate(`window.__jensdjAutomation.clickByTestId("track-${trackId}-play")`);

  // Wait for playback to cross the cue and automation to become active
  let automationFired = false;
  let automationValue = -1;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await sleep(150);
    const snap = await evaluate<Record<string, { backendPosition: number }>>(`
      window.__jensdjAutomation.getPlaybackSnapshot([${JSON.stringify(trackId)}])
    `);
    const pos = snap[trackId]!.backendPosition;

    if (pos > cueTime + 0.1) {
      // We've passed the cue — check automation state
      const state = await evaluate<{ active: boolean; value: number }>(`
        window.__jensdjAutomation.getAutomationState(${JSON.stringify(trackId)}, 2)
      `);
      console.log("[EqAutoE2E] pos:", pos.toFixed(3), "automation:", state);

      if (state.active) {
        automationFired = true;
        automationValue = state.value;
        break;
      }
      // If automation already completed (very short duration), the value should be at endValue
      // Check if it completed by seeing if we're past the expected duration
      const bpm = 120; // fallback
      const twoBarsSeconds = 2 * 4 * (60 / bpm);
      if (pos > cueTime + twoBarsSeconds + 0.5) {
        console.log("[EqAutoE2E] automation may have completed already");
        break;
      }
    }
  }

  console.log("[EqAutoE2E] automationFired:", automationFired, "value:", automationValue);
  expect(automationFired).toBe(true);
  // Value should be between 0 and 1 (transitioning from 1.0 to 0.0)
  expect(automationValue).toBeGreaterThanOrEqual(0);
  expect(automationValue).toBeLessThan(1);

  // Clean up
  await evaluate(`
    (async () => {
      const stop = document.querySelector('[data-testid="track-${trackId}-stop"]');
      if (stop instanceof HTMLElement) stop.click();
      await window.__jensdjAutomation.sleep(300);
      window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(trackId)});
      return true;
    })()
  `);
});

testIfDesktop("1-bar and 2-bar loops via cue automations stay phase-locked", async () => {
  // Stop all tracks
  await evaluate(`
    (async () => {
      const snapshot = await window.__jensdjAutomation.getPlaybackSnapshot();
      for (const [trackId] of Object.entries(snapshot)) {
        const stop = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stop instanceof HTMLElement) stop.click();
      }
      await window.__jensdjAutomation.sleep(500);
      return true;
    })()
  `);

  const trackIds = await evaluate<string[]>("window.__jensdjAutomation.getTrackIds()");
  expect(trackIds.length).toBeGreaterThanOrEqual(2);
  const t1 = trackIds[0]!;
  const t2 = trackIds[1]!;

  // Clean ALL existing cues
  await evaluate(`
    window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(t1)});
    window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(t2)});
  `);

  // Get beat grid to find a good cue position (downbeat ~2s in)
  const ctx = await evaluate<Record<string, { beats: number[]; firstBeat: number }>>(`
    window.__jensdjAutomation.getTrackContext([${JSON.stringify(t1)}, ${JSON.stringify(t2)}])
  `);
  const beats1 = ctx[t1]!.beats;
  const beatInterval = beats1.length > 1 ? beats1[1]! - beats1[0]! : 0.5;
  const barDuration = beatInterval * 4;

  // Find a downbeat ~2s in for the cue/loop position
  let cueTime = beats1[0]!;
  for (let i = 0; i < beats1.length; i += 4) {
    if (beats1[i]! >= 2.0) { cueTime = beats1[i]!; break; }
  }

  console.log("[LoopSyncE2E] t1:", t1, "t2:", t2);
  console.log("[LoopSyncE2E] cueTime:", cueTime, "barDuration:", barDuration.toFixed(4));

  // Step 1: Create cue points on both tracks at the same time
  const cue1 = await evaluate<{ id: string; time: number } | null>(`
    window.__jensdjAutomation.addOrToggleCue(${JSON.stringify(t1)}, ${cueTime})
  `);
  const cue2 = await evaluate<{ id: string; time: number } | null>(`
    window.__jensdjAutomation.addOrToggleCue(${JSON.stringify(t2)}, ${cueTime})
  `);
  expect(cue1).not.toBeNull();
  expect(cue2).not.toBeNull();
  console.log("[LoopSyncE2E] cue1:", cue1, "cue2:", cue2);

  // Step 2: Add loop automations — track 1: 1 bar (4 beats), track 2: 2 bars (8 beats)
  const auto1 = await evaluate<string | null>(`
    window.__jensdjAutomation.addCueAutomation(${JSON.stringify(cue1!.id)}, "loop", 0, 0, 4)
  `);
  const auto2 = await evaluate<string | null>(`
    window.__jensdjAutomation.addCueAutomation(${JSON.stringify(cue2!.id)}, "loop", 0, 0, 8)
  `);
  expect(auto1).not.toBeNull();
  expect(auto2).not.toBeNull();

  // Step 3: Activate both cues (so CueMonitor fires the loop automations)
  await evaluate(`window.__jensdjAutomation.toggleCueActive(${JSON.stringify(cue1!.id)})`);
  await evaluate(`window.__jensdjAutomation.toggleCueActive(${JSON.stringify(cue2!.id)})`);

  // Verify
  const detail1 = await evaluate<{ active: boolean; automations: { type: string }[] } | null>(`
    window.__jensdjAutomation.getCueDetail(${JSON.stringify(cue1!.id)})
  `);
  const detail2 = await evaluate<{ active: boolean; automations: { type: string }[] } | null>(`
    window.__jensdjAutomation.getCueDetail(${JSON.stringify(cue2!.id)})
  `);
  console.log("[LoopSyncE2E] cue1 detail:", detail1);
  console.log("[LoopSyncE2E] cue2 detail:", detail2);
  expect(detail1!.active).toBe(true);
  expect(detail1!.automations[0]!.type).toBe("loop");
  expect(detail2!.active).toBe(true);
  expect(detail2!.automations[0]!.type).toBe("loop");

  // Step 4: Click play on track 1 (CueMonitor will fire the loop when playback crosses the cue)
  await evaluate(`window.__jensdjAutomation.clickByTestId("track-${t1}-play")`);

  // Wait for track 1 to be playing
  await waitFor(async () => {
    const snap = await evaluate<Record<string, { backendIsPlaying: boolean }>>(`
      window.__jensdjAutomation.getPlaybackSnapshot([${JSON.stringify(t1)}])
    `);
    return snap[t1]?.backendIsPlaying === true;
  }, 5000, 100);

  // Wait for track 1 to cross the cue and enter the loop
  await sleep(3000);

  // Step 5: Click play on track 2
  await evaluate(`window.__jensdjAutomation.clickByTestId("track-${t2}-play")`);

  // Wait for track 2 to be playing
  await waitFor(async () => {
    const snap = await evaluate<Record<string, { backendIsPlaying: boolean }>>(`
      window.__jensdjAutomation.getPlaybackSnapshot([${JSON.stringify(t2)}])
    `);
    return snap[t2]?.backendIsPlaying === true;
  }, 5000, 100);

  // Wait for track 2 to cross its cue and enter the loop
  await sleep(3000);

  // Step 6: Sample sync diff using output-frame phase tracking (exact integer math)
  const diffs: number[] = [];
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const diff = await evaluate<number>(`
      window.__jensdjAutomation.getSyncDiff(${JSON.stringify(t1)}, ${JSON.stringify(t2)}, 0, ${barDuration})
    `);
    diffs.push(Math.abs(diff));
    console.log(`[LoopSyncE2E] #${i}: syncDiff=${(diff * 1000).toFixed(3)}ms`);
  }

  const laterDiffs = diffs.slice(3);
  const maxDrift = Math.max(...laterDiffs);
  console.log(`[LoopSyncE2E] maxDrift=${(maxDrift * 1000).toFixed(3)}ms`);

  // Output-frame phase tracking: should be 0 samples (both tracks updated in same callback)
  expect(maxDrift).toBeLessThan(0.001);

  // Clean up
  await evaluate(`
    (async () => {
      const stop1 = document.querySelector('[data-testid="track-${t1}-stop"]');
      const stop2 = document.querySelector('[data-testid="track-${t2}-stop"]');
      if (stop1 instanceof HTMLElement) stop1.click();
      if (stop2 instanceof HTMLElement) stop2.click();
      await window.__jensdjAutomation.sleep(300);
      window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(t1)});
      window.__jensdjAutomation.removeAllCuesForTrack(${JSON.stringify(t2)});
      return true;
    })()
  `);
});

testIfDesktop("synced tracks with different BPMs scroll at same visual rate", async () => {
  // Stop all tracks and reset masterBpm
  await evaluate(`
    (async () => {
      const snapshot = await window.__jensdjAutomation.getPlaybackSnapshot();
      for (const [trackId] of Object.entries(snapshot)) {
        const stop = document.querySelector(\`[data-testid="track-\${trackId}-stop"]\`);
        if (stop instanceof HTMLElement) stop.click();
      }
      await window.__jensdjAutomation.sleep(500);
      return true;
    })()
  `);

  const trackIds = await evaluate<string[]>("window.__jensdjAutomation.getTrackIds()");
  expect(trackIds.length).toBeGreaterThanOrEqual(2);
  const t1 = trackIds[0]!;
  const t2 = trackIds[1]!;

  // Use getTrackContext which has beats — derive BPM from beat spacing
  const ctx = await evaluate<Record<string, {
    beats: number[];
    firstBeat: number;
  }>>(`window.__jensdjAutomation.getTrackContext([${JSON.stringify(t1)}, ${JSON.stringify(t2)}])`);

  const beats1 = ctx[t1]!.beats;
  const beats2 = ctx[t2]!.beats;
  expect(beats1.length).toBeGreaterThan(4);
  expect(beats2.length).toBeGreaterThan(4);

  // Derive BPM from beat spacing
  const bpm1 = 60 / (beats1[1]! - beats1[0]!);
  const bpm2 = 60 / (beats2[1]! - beats2[0]!);
  console.log(`[ScrollRateE2E] bpm1=${bpm1.toFixed(1)} bpm2=${bpm2.toFixed(1)}`);

  // Skip if BPMs are too similar — test only makes sense with different BPMs
  const bpmRatio = Math.max(bpm1, bpm2) / Math.min(bpm1, bpm2);
  if (bpmRatio < 1.05) {
    console.log("[ScrollRateE2E] SKIP: BPMs too similar");
    return;
  }

  // Step 1: Play track 1 (auto-sets masterBpm)
  await evaluate(`window.__jensdjAutomation.clickByTestId("track-${t1}-play")`);
  await sleep(1000);

  // Step 2: Play track 2 (syncs to track 1)
  await evaluate(`window.__jensdjAutomation.clickByTestId("track-${t2}-play")`);
  await sleep(1000);

  // Step 3: Verify tempo is applied in the C engine
  const tempoInfo = await evaluate<Record<string, {
    originalBpm: number;
    tempoRatio: number;
    masterBpm: number;
  }>>(`window.djRpc.request.getTempoInfo({ trackIds: [${JSON.stringify(t1)}, ${JSON.stringify(t2)}] })`);
  console.log("[ScrollRateE2E] tempoInfo:", tempoInfo);

  expect(tempoInfo[t1]!.masterBpm).toBeGreaterThan(0);

  // The tempo ratio should match: for each track, ratio = masterBpm / originalBpm
  const expectedRatio1 = tempoInfo[t1]!.masterBpm / tempoInfo[t1]!.originalBpm;
  const expectedRatio2 = tempoInfo[t2]!.masterBpm / tempoInfo[t2]!.originalBpm;
  expect(Math.abs(tempoInfo[t1]!.tempoRatio - expectedRatio1)).toBeLessThan(0.02);
  expect(Math.abs(tempoInfo[t2]!.tempoRatio - expectedRatio2)).toBeLessThan(0.02);

  // Step 4: Sample positions at two time points to verify scroll rate
  const snap1 = await evaluate<Record<string, {
    backendPosition: number;
    backendIsPlaying: boolean;
  }>>(`window.__jensdjAutomation.getPlaybackSnapshot([${JSON.stringify(t1)}, ${JSON.stringify(t2)}])`);

  await sleep(2000);

  const snap2 = await evaluate<Record<string, {
    backendPosition: number;
    backendIsPlaying: boolean;
  }>>(`window.__jensdjAutomation.getPlaybackSnapshot([${JSON.stringify(t1)}, ${JSON.stringify(t2)}])`);

  expect(snap1[t1]!.backendIsPlaying).toBe(true);
  expect(snap1[t2]!.backendIsPlaying).toBe(true);

  const delta1 = snap2[t1]!.backendPosition - snap1[t1]!.backendPosition;
  const delta2 = snap2[t2]!.backendPosition - snap1[t2]!.backendPosition;

  console.log(`[ScrollRateE2E] delta1=${delta1.toFixed(4)}s delta2=${delta2.toFixed(4)}s`);
  console.log(`[ScrollRateE2E] delta_ratio=${(delta2/delta1).toFixed(4)} expected_ratio=${(bpm1/bpm2).toFixed(4)}`);

  // Key assertion: both tracks should advance at a rate proportional to their BPMs.
  // If track 2 is stretched, delta2/delta1 should equal bpm1/bpm2.
  // Without stretch, delta2/delta1 ≈ 1.0 (both advance at file rate).
  // With correct stretch, delta2/delta1 ≈ bpm1/bpm2.
  //
  // The "visual scroll rate" in a beat-based zoom is:
  //   scroll_rate = delta * bpm / (zoomBeats * 60)
  // For both to be equal: delta1 * bpm1 = delta2 * bpm2
  // i.e., delta2/delta1 = bpm1/bpm2
  const actualDeltaRatio = delta2 / delta1;
  const expectedDeltaRatio = bpm1 / bpm2;
  const tolerance = 0.05; // 5% tolerance for timing jitter

  console.log(`[ScrollRateE2E] actualDeltaRatio=${actualDeltaRatio.toFixed(4)} expectedDeltaRatio=${expectedDeltaRatio.toFixed(4)} tolerance=${tolerance}`);
  expect(Math.abs(actualDeltaRatio - expectedDeltaRatio)).toBeLessThan(tolerance);

  // Clean up
  await evaluate(`
    (async () => {
      const stop1 = document.querySelector('[data-testid="track-${t1}-stop"]');
      const stop2 = document.querySelector('[data-testid="track-${t2}-stop"]');
      if (stop1 instanceof HTMLElement) stop1.click();
      if (stop2 instanceof HTMLElement) stop2.click();
      await window.__jensdjAutomation.sleep(300);
      return true;
    })()
  `);
});
