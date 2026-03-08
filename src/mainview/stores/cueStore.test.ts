import { test, expect, beforeEach, mock } from "bun:test";

// Mock window.djRpc before importing the store
const mockRpc = {
  request: {
    saveCue: mock(() => Promise.resolve()),
    deleteCue: mock(() => Promise.resolve()),
    saveCueAutomation: mock(() => Promise.resolve()),
    deleteCueAutomation: mock(() => Promise.resolve()),
    setAutomation: mock(() => Promise.resolve()),
    cancelAutomation: mock(() => Promise.resolve()),
    saveCollectionTrack: mock(() => Promise.resolve()),
    getCuesForTrack: mock(() => Promise.resolve([])),
    loadTrack: mock(() => Promise.resolve(null)),
  },
};

// @ts-ignore — minimal mock
globalThis.window = globalThis.window ?? {};
// @ts-expect-error — mock djRpc
globalThis.window.djRpc = mockRpc;

// Mock crypto.randomUUID
if (!globalThis.crypto?.randomUUID) {
  let counter = 0;
  // @ts-expect-error — minimal mock
  globalThis.crypto = { randomUUID: () => `test-uuid-${++counter}` };
}

// Now import after mocks are set
const { useCueStore } = await import("./cueStore.ts");
const { usePlayerStore } = await import("./playerStore.ts");

function addMockTrack(trackId: string, filePath: string) {
  usePlayerStore.getState().addTrack({
    id: trackId,
    filePath,
    metadata: { title: "Test", artist: "Test", album: "", genre: "", duration: 300, bpm: 120, key: "", filePath },
    peaks: { low: [], mid: [], high: [] },
    bpm: 120,
    beats: [0, 0.5, 1.0, 1.5, 2.0, 10.0, 20.0, 30.0, 40.0, 50.0],
    duration: 300,
  });
}

beforeEach(() => {
  // Reset stores
  useCueStore.setState({ cues: new Map(), pendingConnection: null, hoveredCueId: null, selectedCueId: null });
  // Reset player store tracks
  usePlayerStore.setState({ tracks: new Map(), selectedTrackId: null });
});

test("addOrToggleCue creates cue at given position", () => {
  addMockTrack("track_1", "/test/file.mp3");
  // Beats at 120 BPM: every 0.5s, downbeats at 0, 2, 4, ... 30, 32, ...
  const beats: number[] = [];
  for (let i = 0; i < 120; i++) beats.push(i * 0.5);

  const cue = useCueStore.getState().addOrToggleCue("track_1", "/test/file.mp3", 30, beats);

  expect(cue).not.toBeNull();
  expect(cue!.time).toBe(30); // should snap to beat at 30.0
  expect(cue!.active).toBe(false);
  expect(cue!.label).toBe("A");
  expect(cue!.trackId).toBe("track_1");
  expect(cue!.filePath).toBe("/test/file.mp3");
});

test("addOrToggleCue at same position toggles active", () => {
  addMockTrack("track_1", "/test/file.mp3");
  // Beats at 120 BPM: every 0.5s, downbeats at 0, 2, 4, ... 30, 32, ...
  const beats: number[] = [];
  for (let i = 0; i < 120; i++) beats.push(i * 0.5);

  // First call: create cue at position 30
  const cue1 = useCueStore.getState().addOrToggleCue("track_1", "/test/file.mp3", 30, beats);
  expect(cue1!.active).toBe(false);

  // Second call at same position: should toggle to active, not create new cue
  useCueStore.getState().addOrToggleCue("track_1", "/test/file.mp3", 30, beats);

  const cues = [...useCueStore.getState().cues.values()].filter(c => c.trackId === "track_1");
  expect(cues.length).toBe(1); // still just 1 cue
  expect(cues[0]!.active).toBe(true); // now active
});

test("addOrToggleCue at different position creates second cue", () => {
  addMockTrack("track_1", "/test/file.mp3");
  // Beats at 120 BPM: every 0.5s, downbeats at 0, 2, 4, ... 30, 32, ...
  const beats: number[] = [];
  for (let i = 0; i < 120; i++) beats.push(i * 0.5);

  useCueStore.getState().addOrToggleCue("track_1", "/test/file.mp3", 30, beats);
  useCueStore.getState().addOrToggleCue("track_1", "/test/file.mp3", 40, beats);

  const cues = [...useCueStore.getState().cues.values()].filter(c => c.trackId === "track_1");
  expect(cues.length).toBe(2);
  expect(cues[0]!.label).toBe("A");
  expect(cues[1]!.label).toBe("B");
});

test("cue placed at provided position, not at zero", () => {
  addMockTrack("track_1", "/test/file.mp3");
  // Beats at 120 BPM: every 0.5s, downbeats at 0, 2, 4, ... 30, 32, ...
  const beats: number[] = [];
  for (let i = 0; i < 120; i++) beats.push(i * 0.5);

  // Simulate: user previews at position 30, then clicks "+CUE"
  usePlayerStore.getState().setLockedPosition("track_1", 30);

  const cue = useCueStore.getState().addOrToggleCue("track_1", "/test/file.mp3", 30, beats);

  expect(cue).not.toBeNull();
  expect(cue!.time).toBe(30);
  expect(cue!.time).toBeGreaterThan(10); // NOT at the beginning
});

test("removeCue deletes cue from store", () => {
  addMockTrack("track_1", "/test/file.mp3");

  const cue = useCueStore.getState().addOrToggleCue("track_1", "/test/file.mp3", 30, [30]);
  expect(useCueStore.getState().cues.size).toBe(1);

  useCueStore.getState().removeCue(cue!.id);
  expect(useCueStore.getState().cues.size).toBe(0);
});

test("toggleActive flips active state", () => {
  addMockTrack("track_1", "/test/file.mp3");

  const cue = useCueStore.getState().addOrToggleCue("track_1", "/test/file.mp3", 30, [30]);
  expect(cue!.active).toBe(false);

  useCueStore.getState().toggleActive(cue!.id);
  expect(useCueStore.getState().cues.get(cue!.id)!.active).toBe(true);

  useCueStore.getState().toggleActive(cue!.id);
  expect(useCueStore.getState().cues.get(cue!.id)!.active).toBe(false);
});

test("loadCuesForTrack creates runtime copies for duplicate filePaths", async () => {
  addMockTrack("track_1", "/test/file.mp3");
  addMockTrack("track_2", "/test/file.mp3");

  const mockCues = [
    {
      id: "persisted-cue-1",
      filePath: "/test/file.mp3",
      trackId: "",
      label: "A",
      time: 30,
      color: "#22c55e",
      active: false,
      automations: [],
    },
  ];

  // @ts-ignore — test mock override
  mockRpc.request.getCuesForTrack = mock(() => Promise.resolve(mockCues));

  // Load for track_1
  await useCueStore.getState().loadCuesForTrack("/test/file.mp3", "track_1");

  const cuesAfterFirst = [...useCueStore.getState().cues.values()];
  expect(cuesAfterFirst.length).toBe(1);
  expect(cuesAfterFirst[0]!.trackId).toBe("track_1");

  // Load for track_2 (same filePath) — should create runtime copy
  await useCueStore.getState().loadCuesForTrack("/test/file.mp3", "track_2");

  const cuesAfterSecond = [...useCueStore.getState().cues.values()];
  expect(cuesAfterSecond.length).toBe(2);

  const track1Cues = cuesAfterSecond.filter(c => c.trackId === "track_1");
  const track2Cues = cuesAfterSecond.filter(c => c.trackId === "track_2");
  expect(track1Cues.length).toBe(1);
  expect(track2Cues.length).toBe(1);
  // Both at same time
  expect(track1Cues[0]!.time).toBe(30);
  expect(track2Cues[0]!.time).toBe(30);
});

test("unloadCuesForTrack removes only that track's cues", () => {
  addMockTrack("track_1", "/test/a.mp3");
  addMockTrack("track_2", "/test/b.mp3");

  useCueStore.getState().addOrToggleCue("track_1", "/test/a.mp3", 10, [10]);
  useCueStore.getState().addOrToggleCue("track_2", "/test/b.mp3", 20, [20]);

  expect(useCueStore.getState().cues.size).toBe(2);

  useCueStore.getState().unloadCuesForTrack("track_1");

  const remaining = [...useCueStore.getState().cues.values()];
  expect(remaining.length).toBe(1);
  expect(remaining[0]!.trackId).toBe("track_2");
});
