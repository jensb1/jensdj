import { Electroview } from "electrobun/view";
import type { MainViewRPC } from "../shared/types.ts";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { MainLayout } from "./components/layout/MainLayout.tsx";
import { debugLogThrottled, logError, logInfo, logWarn } from "./lib/debugLog.ts";
import { usePlayerStore } from "./stores/playerStore.ts";
import { useCueStore } from "./stores/cueStore.ts";

logInfo("view.init");

// Define RPC handlers for messages FROM Bun
const rpc = Electroview.defineRPC<MainViewRPC>({
  maxRequestTime: 120000,
  handlers: {
    requests: {},
    messages: {
      playbackTick: ({ trackId, position, isPlaying, level, loopStart, loopEnd, filterValue, filterAutomationActive, volumeAutomationActive, eqLo, eqMid, eqHi, eqAutomationActive }) => {
        const trackState = usePlayerStore.getState().tracks.get(trackId);
        if (trackState && trackState.isPlaying !== isPlaying) {
          logInfo("playback.stateSync", {
            trackId,
            from: trackState.isPlaying,
            to: isPlaying,
            position: Number(position.toFixed(3)),
          });
          usePlayerStore.getState().setPlaying(trackId, isPlaying);
        }
        // Update automation state in store for UI reflection
        const hasAutoUpdate = filterAutomationActive !== undefined || volumeAutomationActive !== undefined
          || filterValue !== undefined || eqAutomationActive !== undefined;
        if (hasAutoUpdate) {
          usePlayerStore.setState((state) => {
            const ts = state.tracks.get(trackId);
            if (!ts) return state;
            const tracks = new Map(state.tracks);
            tracks.set(trackId, {
              ...ts,
              ...(filterValue !== undefined ? { filterValue } : {}),
              ...(filterAutomationActive !== undefined ? { filterAutomationActive } : {}),
              ...(volumeAutomationActive !== undefined ? { volumeAutomationActive } : {}),
              ...(eqLo !== undefined ? { eqLo } : {}),
              ...(eqMid !== undefined ? { eqMid } : {}),
              ...(eqHi !== undefined ? { eqHi } : {}),
              ...(eqAutomationActive !== undefined ? { eqAutomationActive } : {}),
            });
            return { tracks };
          });
        } else if (trackState?.filterAutomationActive || trackState?.volumeAutomationActive || trackState?.eqAutomationActive) {
          // Automation just finished — clear flags
          usePlayerStore.setState((state) => {
            const ts = state.tracks.get(trackId);
            if (!ts) return state;
            const tracks = new Map(state.tracks);
            tracks.set(trackId, { ...ts, filterAutomationActive: false, volumeAutomationActive: false, eqAutomationActive: false });
            return { tracks };
          });
        }
        debugLogThrottled(`playbackTick:${trackId}`, 1000, "index.playbackTick", {
          trackId,
          position: Number(position.toFixed(3)),
          isPlaying,
          level: Number(level.toFixed(3)),
          loopStart: loopStart != null ? Number(loopStart.toFixed(3)) : null,
          loopEnd: loopEnd != null ? Number(loopEnd.toFixed(3)) : null,
        });
        window.dispatchEvent(
          new CustomEvent("dj:playbackTick", {
            detail: { trackId, position, isPlaying, level, loopStart, loopEnd },
          })
        );
      },
      scanProgress: ({ current, total, file }) => {
        window.dispatchEvent(
          new CustomEvent("dj:scanProgress", {
            detail: { current, total, file },
          })
        );
      },
      trackAnalyzed: ({ trackId, bpm, beats, peaks }) => {
        window.dispatchEvent(
          new CustomEvent("dj:trackAnalyzed", {
            detail: { trackId, bpm, beats, peaks },
          })
        );
      },
      midiState: ({ selectedTrackId, selectedCueIndex, connected, deviceName }) => {
        usePlayerStore.getState().setSelectedTrackId(selectedTrackId);
        usePlayerStore.getState().setMidiConnected(connected, deviceName);
        window.dispatchEvent(
          new CustomEvent("dj:midiState", {
            detail: { selectedTrackId, selectedCueIndex, connected, deviceName },
          })
        );
      },
      midiAction: (payload) => {
        window.dispatchEvent(
          new CustomEvent("dj:midiAction", { detail: payload })
        );
      },
    },
  },
});

const electroview = new Electroview({ rpc });

// Expose RPC globally so React components can call Bun functions
declare global {
  interface Window {
    djRpc: typeof electroview.rpc;
    __jensdjAutomation: {
      clickByTestId: (testId: string) => boolean;
      getTrackIds: () => string[];
      getPlaybackSnapshot: (trackIds?: string[]) => Promise<Record<string, {
        storePosition: number;
        storeIsPlaying: boolean;
        backendPosition: number;
        backendIsPlaying: boolean;
        hasStartedPlayback: boolean;
        previewPosition: number | null;
        lockedPosition: number | null;
      }>>;
      getTrackContext: (trackIds?: string[]) => Promise<Record<string, {
        backendPosition: number;
        backendIsPlaying: boolean;
        firstBeat: number;
        beats: number[];
      }>>;
      sleep: (ms: number) => Promise<boolean>;
      setSelectedTrack: (trackId: string) => void;
      setLockedPosition: (trackId: string, position: number) => void;
      addOrToggleCue: (trackId: string, position: number) => {
        id: string; time: number; active: boolean; label: string;
      } | null;
      getCueSnapshot: (trackId: string) => {
        id: string; time: number; active: boolean; label: string; filePath: string;
      }[];
      getSelectedTrackState: () => {
        trackId: string | null;
        lockedPosition: number | null;
        previewPosition: number | null;
        position: number;
      };
      toggleCueActive: (cueId: string) => boolean;
      connectCues: (sourceCueId: string, targetCueId: string) => boolean;
      getCueDetail: (cueId: string) => {
        id: string; time: number; active: boolean; label: string;
        trackId: string; filePath: string;
        automations: { id: string; type: string; durationBars: number; targetCueId?: string; targetFilePath?: string }[];
      } | null;
      removeAllCuesForTrack: (trackId: string) => number;
      addCueAutomation: (cueId: string, type: string, durationBars: number, startValue: number, endValue: number, interpolation?: string) => string | null;
      getAutomationState: (trackId: string, param: number) => Promise<{ active: boolean; value: number }>;
      getSyncDiff: (trackId1: string, trackId2: string, beatRef: number, barDuration: number) => Promise<number>;
    };
  }
}
window.djRpc = electroview.rpc;

window.__jensdjAutomation = {
  clickByTestId(testId: string) {
    const target = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
      .find((element) => element.dataset.testid === testId);
    if (!target) {
      throw new Error(`No element found for data-testid=${testId}`);
    }
    target.click();
    return true;
  },
  getTrackIds() {
    return Array.from(usePlayerStore.getState().tracks.keys());
  },
  async getPlaybackSnapshot(trackIds?: string[]) {
    const tracks = usePlayerStore.getState().tracks;
    const ids = trackIds && trackIds.length > 0 ? trackIds : Array.from(tracks.keys());
    const snapshot: Record<string, {
      storePosition: number;
      storeIsPlaying: boolean;
      backendPosition: number;
      backendIsPlaying: boolean;
      hasStartedPlayback: boolean;
      previewPosition: number | null;
      lockedPosition: number | null;
    }> = {};

    // Batch read all positions in a single RPC call (back-to-back FFI, effectively atomic)
    const states = await window.djRpc?.request?.getPlaybackStates?.({ trackIds: ids }) ?? {};

    for (const trackId of ids) {
      const storeTrack = tracks.get(trackId);
      if (!storeTrack) continue;
      const playbackState = states[trackId];
      snapshot[trackId] = {
        storePosition: storeTrack.position,
        storeIsPlaying: storeTrack.isPlaying,
        backendPosition: playbackState?.position ?? 0,
        backendIsPlaying: playbackState?.isPlaying ?? false,
        hasStartedPlayback: storeTrack.hasStartedPlayback,
        previewPosition: storeTrack.previewPosition,
        lockedPosition: storeTrack.lockedPosition,
      };
    }

    return snapshot;
  },
  async getTrackContext(trackIds?: string[]) {
    const tracks = usePlayerStore.getState().tracks;
    const ids = trackIds && trackIds.length > 0 ? trackIds : Array.from(tracks.keys());
    const snapshot: Record<string, {
      backendPosition: number;
      backendIsPlaying: boolean;
      firstBeat: number;
      beats: number[];
    }> = {};

    const states = await window.djRpc?.request?.getPlaybackStates?.({ trackIds: ids }) ?? {};

    for (const trackId of ids) {
      const storeTrack = tracks.get(trackId);
      if (!storeTrack) continue;
      const playbackState = states[trackId];
      snapshot[trackId] = {
        backendPosition: playbackState?.position ?? 0,
        backendIsPlaying: playbackState?.isPlaying ?? false,
        firstBeat: storeTrack.track.beats[0] ?? 0,
        beats: storeTrack.track.beats,
      };
    }

    return snapshot;
  },
  async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return true;
  },
  setSelectedTrack(trackId: string) {
    usePlayerStore.getState().setSelectedTrackId(trackId);
  },
  setLockedPosition(trackId: string, position: number) {
    usePlayerStore.getState().setLockedPosition(trackId, position);
    usePlayerStore.getState().setPreviewPosition(trackId, position);
  },
  addOrToggleCue(trackId: string, position: number) {
    const track = usePlayerStore.getState().tracks.get(trackId);
    if (!track) return null;
    const cue = useCueStore.getState().addOrToggleCue(
      trackId, track.track.filePath, position, track.track.beats
    );
    if (!cue) return null;
    return { id: cue.id, time: cue.time, active: cue.active, label: cue.label };
  },
  getCueSnapshot(trackId: string) {
    const cues = useCueStore.getState().cues;
    const result: { id: string; time: number; active: boolean; label: string; filePath: string }[] = [];
    for (const cue of cues.values()) {
      if (cue.trackId === trackId) {
        result.push({ id: cue.id, time: cue.time, active: cue.active, label: cue.label, filePath: cue.filePath });
      }
    }
    return result.sort((a, b) => a.time - b.time);
  },
  getSelectedTrackState() {
    const state = usePlayerStore.getState();
    const trackId = state.selectedTrackId;
    if (!trackId) return { trackId: null, lockedPosition: null, previewPosition: null, position: 0 };
    const ts = state.tracks.get(trackId);
    if (!ts) return { trackId: null, lockedPosition: null, previewPosition: null, position: 0 };
    return {
      trackId,
      lockedPosition: ts.lockedPosition,
      previewPosition: ts.previewPosition,
      position: ts.position,
    };
  },
  toggleCueActive(cueId: string) {
    const cue = useCueStore.getState().cues.get(cueId);
    if (!cue) return false;
    useCueStore.getState().toggleActive(cueId);
    return true;
  },
  connectCues(sourceCueId: string, targetCueId: string) {
    useCueStore.getState().startConnection(sourceCueId);
    useCueStore.getState().completeConnection(targetCueId);
    // Verify it was created
    const source = useCueStore.getState().cues.get(sourceCueId);
    return source?.automations.some(a => a.type === "connect" && a.targetCueId === targetCueId) ?? false;
  },
  getCueDetail(cueId: string) {
    const cue = useCueStore.getState().cues.get(cueId);
    if (!cue) return null;
    return {
      id: cue.id, time: cue.time, active: cue.active, label: cue.label,
      trackId: cue.trackId, filePath: cue.filePath,
      automations: cue.automations.map(a => ({
        id: a.id, type: a.type, durationBars: a.durationBars,
        targetCueId: a.targetCueId, targetFilePath: a.targetFilePath,
      })),
    };
  },
  addCueAutomation(cueId: string, type: string, durationBars: number, startValue: number, endValue: number, interpolation = "linear") {
    const cue = useCueStore.getState().cues.get(cueId);
    if (!cue) return null;
    const id = crypto.randomUUID();
    useCueStore.getState().addAutomation(cueId, {
      id,
      type: type as import("../shared/types.ts").AutomationType,
      durationBars,
      interpolation: interpolation as import("../shared/types.ts").AutomationInterpolation,
      startValue,
      endValue,
    });
    return id;
  },
  async getAutomationState(trackId: string, param: number) {
    const active = await window.djRpc?.request?.isAutomationActive?.({ trackId, param });
    const value = await window.djRpc?.request?.getAutomationValue?.({ trackId, param });
    return { active: !!active, value: value ?? -1 };
  },
  async getSyncDiff(trackId1: string, trackId2: string, beatRef: number, barDuration: number) {
    const diff = await window.djRpc?.request?.getSyncDiff?.({ trackId1, trackId2, beatRef, barDuration });
    return diff ?? 0;
  },
  removeAllCuesForTrack(trackId: string) {
    const cues = useCueStore.getState().cues;
    const toRemove: string[] = [];
    for (const [id, cue] of cues) {
      if (cue.trackId === trackId) toRemove.push(id);
    }
    for (const id of toRemove) {
      useCueStore.getState().removeCue(id);
    }
    return toRemove.length;
  },
};

logInfo("rpc.ready", { hasRpc: !!window.djRpc });

window.addEventListener("error", (event) => {
  logError("window.error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  logWarn("window.unhandledrejection", {
    reason: String(event.reason),
  });
});

// Mount React
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(createElement(MainLayout));
  logInfo("view.mounted");
} else {
  logError("view.rootMissing");
}
