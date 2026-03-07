import { create } from "zustand";
import type { CuePoint, CueConnection } from "../../shared/types.ts";
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

  addOrToggleCue: (trackId: string, filePath: string, time: number, beats?: number[], downbeatOffset?: number) => CuePoint | null;
  removeCue: (id: string) => void;
  updateCue: (id: string, updates: Partial<CuePoint>) => void;
  toggleActive: (id: string) => void;
  startConnection: (cueId: string) => void;
  completeConnection: (targetCueId: string) => void;
  removeConnection: (sourceCueId: string, connectionId: string) => void;
  cancelConnection: () => void;
  setHoveredCueId: (id: string | null) => void;
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

export const useCueStore = create<CueStore>((set, get) => ({
  cues: new Map(),
  pendingConnection: null,
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
      connections: [],
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
      // Remove connections pointing to this cue from all other cues
      for (const [, other] of cues) {
        const filtered = other.connections.filter((c) => c.cueId !== id);
        if (filtered.length !== other.connections.length) {
          cues.set(other.id, { ...other, connections: filtered });
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
    if (newActive && existing.connections.length > 0) {
      const playerTracks = usePlayerStore.getState().tracks;
      for (const conn of existing.connections) {
        // Check if target filePath is already loaded
        let loaded = false;
        for (const [, ts] of playerTracks) {
          if (ts.track.filePath === conn.targetFilePath) {
            loaded = true;
            break;
          }
        }
        if (!loaded) {
          // Auto-load the target track
          window.djRpc?.request?.loadTrack?.({ filePath: conn.targetFilePath }).then((track) => {
            if (track) {
              usePlayerStore.getState().addTrack(track);
              // Load cues for the auto-loaded track
              get().loadCuesForTrack(conn.targetFilePath, track.id);
            }
          });
        }
      }
    }
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
      // Don't add duplicate connections
      if (source.connections.some((c) => c.cueId === targetCueId)) return { pendingConnection: null };

      const connId = crypto.randomUUID();
      const newConn: CueConnection = {
        id: connId,
        cueId: targetCueId,
        targetFilePath: target.filePath,
        action: "start",
      };

      const cues = new Map(state.cues);
      cues.set(sourceCueId, {
        ...source,
        connections: [...source.connections, newConn],
      });

      // Persist connection
      window.djRpc?.request?.saveCueConnection?.({
        id: connId,
        sourceCueId,
        targetCueId,
        targetFilePath: target.filePath,
        action: "start",
      });

      return { cues, pendingConnection: null };
    }),

  removeConnection: (sourceCueId, connectionId) =>
    set((state) => {
      const source = state.cues.get(sourceCueId);
      if (!source) return state;
      const cues = new Map(state.cues);
      cues.set(sourceCueId, {
        ...source,
        connections: source.connections.filter((c) => c.id !== connectionId),
      });

      // Persist deletion
      window.djRpc?.request?.deleteCueConnection?.({ connectionId });

      return { cues };
    }),

  cancelConnection: () => set({ pendingConnection: null }),

  setHoveredCueId: (id) => set({ hoveredCueId: id }),

  loadCuesForTrack: async (filePath, trackId) => {
    try {
      const dbCues = await window.djRpc?.request?.getCuesForTrack?.({ filePath });
      if (!dbCues || dbCues.length === 0) return;

      set((state) => {
        const newCues = new Map(state.cues);
        // Check if another loaded track already owns these persistent cue IDs.
        // If so, create runtime copies with unique keys for this trackId.
        for (const cue of dbCues) {
          const existing = newCues.get(cue.id);
          if (existing && existing.trackId !== trackId) {
            // Another track instance already has this cue — create a runtime copy
            const runtimeId = `${cue.id}:${trackId}`;
            newCues.set(runtimeId, { ...cue, id: runtimeId, trackId });
          } else {
            newCues.set(cue.id, { ...cue, trackId });
          }
        }
        return { cues: newCues };
      });
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
