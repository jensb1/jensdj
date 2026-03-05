import { create } from "zustand";
import type { LoadedTrack, OutputDevice } from "../../shared/types.ts";

export interface TrackState {
  track: LoadedTrack;
  position: number;
  isPlaying: boolean;
  volume: number;
  deviceId: number;
}

interface PlayerStore {
  tracks: Map<string, TrackState>;
  devices: OutputDevice[];

  addTrack: (track: LoadedTrack) => void;
  removeTrack: (trackId: string) => void;
  updatePosition: (trackId: string, position: number) => void;
  setPlaying: (trackId: string, isPlaying: boolean) => void;
  setVolume: (trackId: string, volume: number) => void;
  setDeviceId: (trackId: string, deviceId: number) => void;
  setDevices: (devices: OutputDevice[]) => void;
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  tracks: new Map(),
  devices: [],

  addTrack: (track) =>
    set((state) => {
      const tracks = new Map(state.tracks);
      tracks.set(track.id, {
        track,
        position: 0,
        isPlaying: false,
        volume: 1,
        deviceId: -1,
      });
      return { tracks };
    }),

  removeTrack: (trackId) =>
    set((state) => {
      const tracks = new Map(state.tracks);
      tracks.delete(trackId);
      return { tracks };
    }),

  updatePosition: (trackId, position) =>
    set((state) => {
      const existing = state.tracks.get(trackId);
      if (!existing) return state;
      const tracks = new Map(state.tracks);
      tracks.set(trackId, { ...existing, position });
      return { tracks };
    }),

  setPlaying: (trackId, isPlaying) =>
    set((state) => {
      const existing = state.tracks.get(trackId);
      if (!existing) return state;
      const tracks = new Map(state.tracks);
      tracks.set(trackId, { ...existing, isPlaying });
      return { tracks };
    }),

  setVolume: (trackId, volume) =>
    set((state) => {
      const existing = state.tracks.get(trackId);
      if (!existing) return state;
      const tracks = new Map(state.tracks);
      tracks.set(trackId, { ...existing, volume });
      return { tracks };
    }),

  setDeviceId: (trackId, deviceId) =>
    set((state) => {
      const existing = state.tracks.get(trackId);
      if (!existing) return state;
      const tracks = new Map(state.tracks);
      tracks.set(trackId, { ...existing, deviceId });
      return { tracks };
    }),

  setDevices: (devices) => set({ devices }),
}));

// Position updates go directly to DOM via TrackRow refs (no React re-render).
// The dj:playbackTick CustomEvent is consumed by TrackRow useEffect.
