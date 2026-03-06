import { create } from "zustand";
import type { CuePoint } from "../../shared/types.ts";

const CUE_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const CUE_COLORS = [
  "#22c55e", "#3b82f6", "#f97316", "#a855f7",
  "#ef4444", "#06b6d4", "#eab308", "#ec4899",
];

interface CueStore {
  cues: Map<string, CuePoint>;
  pendingConnection: string | null; // cueId waiting for a target
  hoveredCueId: string | null;

  addCue: (trackId: string, time: number) => CuePoint;
  removeCue: (id: string) => void;
  updateCue: (id: string, updates: Partial<CuePoint>) => void;
  startConnection: (cueId: string) => void;
  completeConnection: (targetCueId: string) => void;
  removeConnection: (sourceCueId: string, targetCueId: string) => void;
  cancelConnection: () => void;
  setHoveredCueId: (id: string | null) => void;
}

let nextId = 1;

export const useCueStore = create<CueStore>((set, get) => ({
  cues: new Map(),
  pendingConnection: null,
  hoveredCueId: null,

  addCue: (trackId, time) => {
    const allCues = get().cues;
    const trackCues: CuePoint[] = [];
    for (const cue of allCues.values()) {
      if (cue.trackId === trackId) trackCues.push(cue);
    }
    const idx = trackCues.length;
    const label = CUE_LABELS[idx] ?? `${idx + 1}`;
    const color = CUE_COLORS[idx % CUE_COLORS.length]!;

    const cue: CuePoint = {
      id: `cue_${nextId++}`,
      trackId,
      label,
      time,
      color,
      connections: [],
    };

    set((state) => {
      const cues = new Map(state.cues);
      cues.set(cue.id, cue);
      return { cues };
    });

    return cue;
  },

  removeCue: (id) =>
    set((state) => {
      const cues = new Map(state.cues);
      // Remove connections pointing to this cue from all other cues
      for (const [, other] of cues) {
        if (other.connections.some((c) => c.cueId === id)) {
          cues.set(other.id, {
            ...other,
            connections: other.connections.filter((c) => c.cueId !== id),
          });
        }
      }
      cues.delete(id);
      return { cues, pendingConnection: state.pendingConnection === id ? null : state.pendingConnection };
    }),

  updateCue: (id, updates) =>
    set((state) => {
      const existing = state.cues.get(id);
      if (!existing) return state;
      const cues = new Map(state.cues);
      cues.set(id, { ...existing, ...updates });
      return { cues };
    }),

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

      const cues = new Map(state.cues);
      cues.set(sourceCueId, {
        ...source,
        connections: [...source.connections, { cueId: targetCueId, trackId: target.trackId, action: "start" }],
      });
      return { cues, pendingConnection: null };
    }),

  removeConnection: (sourceCueId, targetCueId) =>
    set((state) => {
      const source = state.cues.get(sourceCueId);
      if (!source) return state;
      const cues = new Map(state.cues);
      cues.set(sourceCueId, {
        ...source,
        connections: source.connections.filter((c) => c.cueId !== targetCueId),
      });
      return { cues };
    }),

  cancelConnection: () => set({ pendingConnection: null }),

  setHoveredCueId: (id) => set({ hoveredCueId: id }),
}));
