import { create } from "zustand";
import type { LoadedTrack, OutputDevice } from "../../shared/types.ts";
import { debugLog, logInfo } from "../lib/debugLog.ts";

export interface TrackState {
  track: LoadedTrack;
  position: number;
  isPlaying: boolean;
  volume: number;
  deviceId: number;
  previewPosition: number | null;
  lockedPosition: number | null; // when set, zoomed waveform stays here instead of following playback
  level: number;
}

interface PlayerStore {
  tracks: Map<string, TrackState>;
  devices: OutputDevice[];
  masterBpm: number; // 0 = off, >0 = all tracks sync to this

  addTrack: (track: LoadedTrack) => void;
  removeTrack: (trackId: string) => void;
  updatePosition: (trackId: string, position: number) => void;
  setPlaying: (trackId: string, isPlaying: boolean) => void;
  setVolume: (trackId: string, volume: number) => void;
  setDeviceId: (trackId: string, deviceId: number) => void;
  setDevices: (devices: OutputDevice[]) => void;
  setPreviewPosition: (trackId: string, position: number | null) => void;
  setLockedPosition: (trackId: string, position: number | null) => void;
  setLevel: (trackId: string, level: number) => void;
  setMasterBpm: (bpm: number) => void;
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  tracks: new Map(),
  devices: [],
  masterBpm: 0,

  addTrack: (track) =>
    set((state) => {
      debugLog("playerStore.addTrack", {
        trackId: track.id,
        title: track.metadata.title,
        duration: Number(track.duration.toFixed(3)),
      });
      logInfo("track.loaded", {
        trackId: track.id,
        title: track.metadata.title,
        duration: Number(track.duration.toFixed(3)),
      });
      const tracks = new Map(state.tracks);
      tracks.set(track.id, {
        track,
        position: 0,
        isPlaying: false,
        volume: 1,
        deviceId: -1,
        previewPosition: null,
        lockedPosition: null,
        level: 0,
      });
      return { tracks };
    }),

  removeTrack: (trackId) =>
    set((state) => {
      debugLog("playerStore.removeTrack", { trackId });
      logInfo("track.removed", { trackId });
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
      if (existing.isPlaying === isPlaying) return state;
      debugLog("playerStore.setPlaying", {
        trackId,
        from: existing.isPlaying,
        to: isPlaying,
        lockedPosition: existing.lockedPosition,
        previewPosition: existing.previewPosition,
      });
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

  setPreviewPosition: (trackId, position) =>
    set((state) => {
      const existing = state.tracks.get(trackId);
      if (!existing) return state;
      debugLog("playerStore.setPreviewPosition", {
        trackId,
        from: existing.previewPosition,
        to: position,
      });
      const tracks = new Map(state.tracks);
      tracks.set(trackId, { ...existing, previewPosition: position });
      return { tracks };
    }),

  setLockedPosition: (trackId, position) =>
    set((state) => {
      const existing = state.tracks.get(trackId);
      if (!existing) return state;
      debugLog("playerStore.setLockedPosition", {
        trackId,
        from: existing.lockedPosition,
        to: position,
        isPlaying: existing.isPlaying,
      });
      const tracks = new Map(state.tracks);
      tracks.set(trackId, { ...existing, lockedPosition: position });
      return { tracks };
    }),

  setLevel: (trackId, level) =>
    set((state) => {
      const existing = state.tracks.get(trackId);
      if (!existing) return state;
      const tracks = new Map(state.tracks);
      tracks.set(trackId, { ...existing, level });
      return { tracks };
    }),

  setMasterBpm: (bpm) => set({ masterBpm: bpm }),
}));

// Position updates go directly to DOM via TrackRow refs (no React re-render).
// The dj:playbackTick CustomEvent is consumed by TrackRow useEffect.
