import { create } from "zustand";
import type { CuePoint, CueAutomation } from "../../shared/types.ts";
import { usePlayerStore } from "./playerStore.ts";

const CUE_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const CUE_COLORS = [
  "#22c55e", "#3b82f6", "#f97316", "#a855f7",
  "#ef4444", "#06b6d4", "#eab308", "#ec4899",
];

const CUE_SNAP_TOLERANCE = 0.05; // seconds — cues closer than this are considered "same position"

interface CueStore {
  cues: Map<string, CuePoint>;
  pendingConnection: string | null;
  hoveredCueId: string | null;
  selectedCueId: string | null;

  addOrToggleCue: (trackId: string, filePath: string, time: number, beats?: number[], downbeatOffset?: number) => CuePoint | null;
  removeCue: (id: string) => void;
  updateCue: (id: string, updates: Partial<CuePoint>) => void;
  toggleActive: (id: string) => void;
  addAutomation: (cueId: string, automation: CueAutomation) => void;
  removeAutomation: (cueId: string, automationId: string) => void;
  updateAutomation: (cueId: string, automationId: string, updates: Partial<CueAutomation>) => void;
  startConnection: (cueId: string) => void;
  completeConnection: (targetCueId: string) => void;
  cancelConnection: () => void;
  setHoveredCueId: (id: string | null) => void;
  setSelectedCueId: (id: string | null) => void;
  loadCuesForTrack: (filePath: string, trackId: string) => Promise<void>;
  unloadCuesForTrack: (trackId: string) => void;
}

function snapToNearestDownbeat(time: number, beats?: number[], downbeatOffset = 0): number {
  if (!beats || beats.length === 0) return time;
  // Extract only downbeats (beat 1 of each bar)
  const downbeats: number[] = [];
  for (let i = downbeatOffset; i < beats.length; i += 4) {
    downbeats.push(beats[i]!);
  }
  if (downbeats.length === 0) return time;
  let nearest = downbeats[0]!;
  let minDist = Infinity;
  for (const bt of downbeats) {
    const d = Math.abs(bt - time);
    if (d < minDist) { minDist = d; nearest = bt; }
  }
  return nearest;
}

function saveCollectionTrackIfNeeded(filePath: string) {
  const playerState = usePlayerStore.getState();
  for (const [, ts] of playerState.tracks) {
    if (ts.track.filePath === filePath) {
      window.djRpc?.request?.saveCollectionTrack?.({
        filePath,
        title: ts.track.metadata.title,
        artist: ts.track.metadata.artist,
        album: ts.track.metadata.album,
        genre: ts.track.metadata.genre,
        duration: ts.track.duration,
        bpm: ts.track.bpm,
        key: ts.track.metadata.key,
        peaks: ts.track.peaks,
        beats: ts.track.beats,
      });
      return;
    }
  }
}

/** Sync the C engine loop from a cue's loop automation (if any). */
function syncLoopFromCue(cue: CuePoint) {
  const loopAuto = cue.automations.find((a) => a.type === "loop");
  if (!loopAuto) return;
  const trackId = cue.trackId;
  if (!trackId) return;
  const trackState = usePlayerStore.getState().tracks.get(trackId);
  const bpm = trackState?.track.bpm ?? 120;
  const loopBeats = loopAuto.endValue > 0 ? loopAuto.endValue : 16;
  const beatDuration = 60 / bpm;
  const loopLen = loopBeats * beatDuration;
  window.djRpc?.request?.setLoop?.({
    trackId,
    startSec: cue.time,
    endSec: cue.time + loopLen,
  });
}

export const useCueStore = create<CueStore>((set, get) => ({
  cues: new Map(),
  pendingConnection: null,
  selectedCueId: null,
  hoveredCueId: null,

  addOrToggleCue: (trackId, filePath, time, beats, downbeatOffset = 0) => {
    time = snapToNearestDownbeat(time, beats, downbeatOffset);

    // Check if a cue exists near this time for this track
    const allCues = get().cues;
    for (const cue of allCues.values()) {
      if (cue.trackId === trackId && Math.abs(cue.time - time) < CUE_SNAP_TOLERANCE) {
        // Toggle active
        get().toggleActive(cue.id);
        return cue;
      }
    }

    // Create new cue
    const trackCues: CuePoint[] = [];
    for (const cue of allCues.values()) {
      if (cue.trackId === trackId) trackCues.push(cue);
    }
    const idx = trackCues.length;
    const label = CUE_LABELS[idx] ?? `${idx + 1}`;
    const color = CUE_COLORS[idx % CUE_COLORS.length]!;

    const cue: CuePoint = {
      id: crypto.randomUUID(),
      filePath,
      trackId,
      label,
      time,
      color,
      active: false,
      automations: [],
    };

    set((state) => {
      const cues = new Map(state.cues);
      cues.set(cue.id, cue);
      return { cues };
    });

    // Persist cue
    window.djRpc?.request?.saveCue?.({
      cue: { id: cue.id, filePath, label, time, color, active: false },
    });

    // Save track to collection on first cue
    if (trackCues.length === 0) {
      saveCollectionTrackIfNeeded(filePath);
    }

    return cue;
  },

  removeCue: (id) => {
    const cue = get().cues.get(id);
    if (!cue) return;

    set((state) => {
      const cues = new Map(state.cues);
      // Remove automations referencing this cue from other cues
      for (const [, other] of cues) {
        const filtered = other.automations.filter((a) => a.targetCueId !== id);
        if (filtered.length !== other.automations.length) {
          cues.set(other.id, { ...other, automations: filtered });
        }
      }
      cues.delete(id);
      return { cues, pendingConnection: state.pendingConnection === id ? null : state.pendingConnection };
    });

    // Persist deletion
    window.djRpc?.request?.deleteCue?.({ cueId: id });
  },

  updateCue: (id, updates) =>
    set((state) => {
      const existing = state.cues.get(id);
      if (!existing) return state;
      const cues = new Map(state.cues);
      const updated = { ...existing, ...updates };
      cues.set(id, updated);

      // Persist if time/active/label/color changed
      if (updates.time !== undefined || updates.active !== undefined || updates.label !== undefined || updates.color !== undefined) {
        window.djRpc?.request?.saveCue?.({
          cue: { id, filePath: updated.filePath, label: updated.label, time: updated.time, color: updated.color, active: updated.active },
        });
      }

      // If cue time moved and has active loop automation, update the C engine loop
      if (updates.time !== undefined) {
        syncLoopFromCue(updated);
      }

      return { cues };
    }),

  toggleActive: (id) => {
    const existing = get().cues.get(id);
    if (!existing) return;
    const newActive = !existing.active;

    set((state) => {
      const cues = new Map(state.cues);
      cues.set(id, { ...existing, active: newActive });
      return { cues };
    });

    // Persist
    window.djRpc?.request?.saveCue?.({
      cue: { id, filePath: existing.filePath, label: existing.label, time: existing.time, color: existing.color, active: newActive },
    });

    // Auto-load connected tracks if activating
    if (newActive) {
      const connectAutos = existing.automations.filter((a) => a.type === "connect" && a.targetFilePath);
      if (connectAutos.length > 0) {
        const playerTracks = usePlayerStore.getState().tracks;
        for (const auto of connectAutos) {
          let loaded = false;
          for (const [, ts] of playerTracks) {
            if (ts.track.filePath === auto.targetFilePath) {
              loaded = true;
              break;
            }
          }
          if (!loaded && auto.targetFilePath) {
            window.djRpc?.request?.loadTrack?.({ filePath: auto.targetFilePath }).then((track) => {
              if (track) {
                usePlayerStore.getState().addTrack(track);
                get().loadCuesForTrack(auto.targetFilePath!, track.id);
              }
            });
          }
        }
      }
    }
  },

  addAutomation: (cueId, automation) => {
    set((state) => {
      const cue = state.cues.get(cueId);
      if (!cue) return state;
      const cues = new Map(state.cues);
      cues.set(cueId, { ...cue, automations: [...cue.automations, automation] });
      return { cues };
    });

    // Persist
    const cue = get().cues.get(cueId);
    if (cue) {
      window.djRpc?.request?.saveCueAutomation?.({
        id: automation.id,
        cueId,
        type: automation.type,
        durationBars: automation.durationBars,
        interpolation: automation.interpolation,
        startValue: automation.startValue,
        endValue: automation.endValue,
        targetCueId: automation.targetCueId,
        targetFilePath: automation.targetFilePath,
      });
    }
  },

  removeAutomation: (cueId, automationId) => {
    const cue = get().cues.get(cueId);
    const removedAuto = cue?.automations.find((a) => a.id === automationId);
    set((state) => {
      const c = state.cues.get(cueId);
      if (!c) return state;
      const cues = new Map(state.cues);
      cues.set(cueId, { ...c, automations: c.automations.filter((a) => a.id !== automationId) });
      return { cues };
    });
    window.djRpc?.request?.deleteCueAutomation?.({ automationId });
    // Clear engine loop if a loop automation was removed
    if (removedAuto?.type === "loop" && cue?.trackId) {
      window.djRpc?.request?.clearLoop?.({ trackId: cue.trackId });
    }
  },

  updateAutomation: (cueId, automationId, updates) => {
    set((state) => {
      const cue = state.cues.get(cueId);
      if (!cue) return state;
      const cues = new Map(state.cues);
      const updatedAutos = cue.automations.map((a) =>
        a.id === automationId ? { ...a, ...updates } : a
      );
      cues.set(cueId, { ...cue, automations: updatedAutos });

      // Persist
      const updated = updatedAutos.find((a) => a.id === automationId);
      if (updated) {
        window.djRpc?.request?.saveCueAutomation?.({
          id: updated.id,
          cueId,
          type: updated.type,
          durationBars: updated.durationBars,
          interpolation: updated.interpolation,
          startValue: updated.startValue,
          endValue: updated.endValue,
          targetCueId: updated.targetCueId,
          targetFilePath: updated.targetFilePath,
        });
      }

      // Sync loop if loop automation endValue changed
      if (updated && updated.type === "loop") {
        const updatedCue = cues.get(cueId);
        if (updatedCue) syncLoopFromCue(updatedCue);
      }

      return { cues };
    });
  },

  startConnection: (cueId) => set({ pendingConnection: cueId }),

  completeConnection: (targetCueId) =>
    set((state) => {
      const sourceCueId = state.pendingConnection;
      if (!sourceCueId) return state;
      const source = state.cues.get(sourceCueId);
      const target = state.cues.get(targetCueId);
      if (!source || !target) return { pendingConnection: null };
      if (source.trackId === target.trackId) return { pendingConnection: null };
      // Don't add duplicate connect automations
      if (source.automations.some((a) => a.type === "connect" && a.targetCueId === targetCueId)) {
        return { pendingConnection: null };
      }

      const autoId = crypto.randomUUID();
      const newAuto: CueAutomation = {
        id: autoId,
        type: "connect",
        durationBars: 0,
        interpolation: "linear",
        startValue: 0,
        endValue: 1,
        targetCueId,
        targetFilePath: target.filePath,
      };

      const cues = new Map(state.cues);
      cues.set(sourceCueId, {
        ...source,
        automations: [...source.automations, newAuto],
      });

      // Persist
      window.djRpc?.request?.saveCueAutomation?.({
        id: autoId,
        cueId: sourceCueId,
        type: "connect",
        durationBars: 0,
        interpolation: "linear",
        startValue: 0,
        endValue: 1,
        targetCueId,
        targetFilePath: target.filePath,
      });

      return { cues, pendingConnection: null };
    }),

  cancelConnection: () => set({ pendingConnection: null }),

  setHoveredCueId: (id) => set({ hoveredCueId: id }),
  setSelectedCueId: (id) => set({ selectedCueId: id }),

  loadCuesForTrack: async (filePath, trackId) => {
    try {
      const dbCues = await window.djRpc?.request?.getCuesForTrack?.({ filePath });
      if (!dbCues || dbCues.length === 0) return;

      const resolvedCues: CuePoint[] = [];
      set((state) => {
        const newCues = new Map(state.cues);
        // Check if another loaded track already owns these persistent cue IDs.
        // If so, create runtime copies with unique keys for this trackId.
        for (const cue of dbCues) {
          const existing = newCues.get(cue.id);
          if (existing && existing.trackId !== trackId) {
            // Another track instance already has this cue — create a runtime copy
            const runtimeId = `${cue.id}:${trackId}`;
            const resolved = { ...cue, id: runtimeId, trackId };
            newCues.set(runtimeId, resolved);
            resolvedCues.push(resolved);
          } else {
            const resolved = { ...cue, trackId };
            newCues.set(cue.id, resolved);
            resolvedCues.push(resolved);
          }
        }
        return { cues: newCues };
      });

      // Restore loop state in C engine for any active cues with loop automations
      for (const cue of resolvedCues) {
        if (cue.active) syncLoopFromCue(cue);
      }
    } catch (e) {
      console.warn("[CueStore] Failed to load cues for", filePath, e);
    }
  },

  unloadCuesForTrack: (trackId) =>
    set((state) => {
      const cues = new Map(state.cues);
      for (const [id, cue] of cues) {
        if (cue.trackId === trackId) cues.delete(id);
      }
      return { cues };
    }),
}));
