import { create } from "zustand";
import type { LoadedTrack, OutputDevice } from "../../shared/types.ts";
import { debugLog, logInfo } from "../lib/debugLog.ts";

export interface TrackState {
  track: LoadedTrack;
  position: number;
  isPlaying: boolean;
  hasStartedPlayback: boolean;
  volume: number;
  deviceId: number;
  previewPosition: number | null;
  lockedPosition: number | null; // when set, zoomed waveform stays here instead of following playback
  level: number;
  filterValue: number;  // 0.0=full LP, 0.5=bypass, 1.0=full HP
  filterAutomationActive: boolean;
  volumeAutomationActive: boolean;
  eqLo: number;
  eqMid: number;
  eqHi: number;
  eqAutomationActive: boolean;
}

interface PlayerStore {
  tracks: Map<string, TrackState>;
  devices: OutputDevice[];
  masterBpm: number; // 0 = off, >0 = all tracks sync to this
  selectedTrackId: string | null; // MIDI-selected track
  midiConnected: boolean;
  midiDeviceName: string | null;

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
  setSelectedTrackId: (trackId: string | null) => void;
  setMidiConnected: (connected: boolean, deviceName: string | null) => void;
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  tracks: new Map(),
  devices: [],
  masterBpm: 0,
  selectedTrackId: null,
  midiConnected: false,
  midiDeviceName: null,

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
      const initialPosition = track.beats[0] ?? 0;
      const tracks = new Map(state.tracks);
      tracks.set(track.id, {
        track,
        position: initialPosition,
        isPlaying: false,
        hasStartedPlayback: false,
        volume: 1,
        deviceId: -1,
        previewPosition: null,
        lockedPosition: null,
        level: 0,
        filterValue: 0.5,
        filterAutomationActive: false,
        volumeAutomationActive: false,
        eqLo: 1,
        eqMid: 1,
        eqHi: 1,
        eqAutomationActive: false,
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
        hasStartedPlayback: existing.hasStartedPlayback,
        lockedPosition: existing.lockedPosition,
        previewPosition: existing.previewPosition,
      });
      const tracks = new Map(state.tracks);
      tracks.set(trackId, {
        ...existing,
        isPlaying,
        hasStartedPlayback: existing.hasStartedPlayback || isPlaying,
      });
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

  setSelectedTrackId: (trackId) => set({ selectedTrackId: trackId }),

  setMidiConnected: (connected, deviceName) =>
    set({ midiConnected: connected, midiDeviceName: deviceName }),
}));

// Position updates go directly to DOM via TrackRow refs (no React re-render).
// The dj:playbackTick CustomEvent is consumed by TrackRow useEffect.
