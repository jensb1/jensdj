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
    active: boolean; connections: { cueId: string }[];
  } | null>(`window.__jensdjAutomation.getCueDetail(${JSON.stringify(sourceCue!.id)})`);
  expect(sourceDetail!.active).toBe(true);

  // Step 3: Connect source → target
  const connected = await evaluate<boolean>(`
    window.__jensdjAutomation.connectCues(${JSON.stringify(sourceCue!.id)}, ${JSON.stringify(targetCue!.id)})
  `);
  expect(connected).toBe(true);

  // Verify connection exists
  const sourceAfterConnect = await evaluate<{
    active: boolean;
    connections: { cueId: string; action: string }[];
  } | null>(`window.__jensdjAutomation.getCueDetail(${JSON.stringify(sourceCue!.id)})`);
  console.log("[CueFireE2E] source after connect:", sourceAfterConnect);
  expect(sourceAfterConnect!.connections.length).toBe(1);
  expect(sourceAfterConnect!.connections[0]!.cueId).toBe(targetCue!.id);
  expect(sourceAfterConnect!.connections[0]!.action).toBe("start");

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
