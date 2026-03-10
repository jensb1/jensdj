import type { RPCSchema } from "electrobun";

// Track metadata from music-metadata + analysis
export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  bpm: number;
  key: string;
  filePath: string;
}

// Loaded track with analysis data
export interface Peaks3Band {
  low: number[];
  mid: number[];
  high: number[];
}

export interface LoadedTrack {
  id: string;
  filePath: string;
  metadata: TrackMetadata;
  peaks: Peaks3Band;
  bpm: number;
  beats: number[];
  duration: number;
}

// Output device info
export interface OutputDevice {
  id: number;
  name: string;
  channels: number;
}

// Playback state
export interface PlaybackState {
  position: number;
  isPlaying: boolean;
}

// EQ settings
export interface EQSettings {
  lo: number;
  mid: number;
  hi: number;
}

// Beat connection between tracks
export interface BeatConnection {
  id: string;
  sourceTrackId: string;
  sourceBeat: number;
  targetTrackId: string;
  targetBeat: number;
}

// Cue automation types
export type AutomationType = 'filter' | 'eq_lo' | 'eq_mid' | 'eq_hi' | 'stop' | 'connect' | 'loop';
export type AutomationInterpolation = 'linear' | 'easeIn' | 'easeOut';

export interface CueAutomation {
  id: string;
  type: AutomationType;
  durationBars: number;            // 0 = immediate, N = over N bars
  interpolation: AutomationInterpolation;
  startValue: number;              // filter: 0..1 (0=LP, 0.5=bypass, 1=HP), EQ: 0..2 (1=unity)
  endValue: number;
  // Connect type only:
  targetCueId?: string;
  targetFilePath?: string;
}

// C engine param constants (must match djengine.c)
export const DJ_PARAM_FILTER = 0;
export const DJ_PARAM_VOLUME = 1;
export const DJ_PARAM_EQ_LO = 2;
export const DJ_PARAM_EQ_MID = 3;
export const DJ_PARAM_EQ_HI = 4;
export const DJ_INTERP_LINEAR = 0;
export const DJ_INTERP_EASE_IN = 1;
export const DJ_INTERP_EASE_OUT = 2;

export interface CuePoint {
  id: string;              // persistent UUID
  filePath: string;        // stable track identifier
  trackId: string;         // runtime-only, set when track is loaded
  label: string;           // 'A', 'B', 'C', 'D', ...
  time: number;            // seconds, snapped to beat
  color: string;
  active: boolean;
  automations: CueAutomation[];
}

// Persisted track in the DJ collection
export interface CollectionTrack {
  filePath: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  bpm: number;
  key: string;
  peaks: Peaks3Band | null;
  beats: number[] | null;
  cues: CuePoint[];
  addedAt: string;
}

// RPC type definitions for Electrobun
export type MainViewRPC = {
  bun: RPCSchema<{
    requests: {
      loadTrack: {
        params: { filePath: string };
        response: LoadedTrack;
      };
      unloadTrack: {
        params: { trackId: string };
        response: void;
      };
      play: {
        params: { trackId: string; fromTime?: number };
        response: void;
      };
      pause: {
        params: { trackId: string };
        response: void;
      };
      stop: {
        params: { trackId: string };
        response: void;
      };
      seek: {
        params: { trackId: string; seconds: number };
        response: void;
      };
      setVolume: {
        params: { trackId: string; volume: number };
        response: void;
      };
      setEQ: {
        params: { trackId: string; eq: EQSettings };
        response: void;
      };
      setOutputDevice: {
        params: { trackId: string; deviceId: number };
        response: void;
      };
      getOutputDevices: {
        params: Record<string, never>;
        response: OutputDevice[];
      };
      scheduleSyncPlay: {
        params: {
          targetTrackId: string;
          targetBeatSeconds: number;
          sourceTrackId: string;
          sourceBeatSeconds: number;
        };
        response: boolean;
      };
      syncStart: {
        params: {
          targetTrackId: string;
          targetBeat: number;
          sourceTrackId: string;
          sourceBeat: number;
          barDuration: number;
          preserveTransport?: boolean;
        };
        response: boolean;
      };
      cancelScheduledStart: {
        params: { trackId: string };
        response: void;
      };
      setLoop: {
        params: { trackId: string; startSec: number; endSec: number };
        response: void;
      };
      clearLoop: {
        params: { trackId: string };
        response: void;
      };
      setMasterBpm: {
        params: { bpm: number };
        response: void;
      };
      alignGlobalClock: {
        params: { trackId: string };
        response: void;
      };
      setFilter: {
        params: { trackId: string; value: number };
        response: void;
      };
      getMidiDevices: {
        params: Record<string, never>;
        response: { sources: string[]; destinations: string[] };
      };
      openMidiInput: {
        params: { sourceIndex: number };
        response: boolean;
      };
      getPlaybackState: {
        params: { trackId: string };
        response: PlaybackState;
      };
      getSyncDiff: {
        params: { trackId1: string; trackId2: string; beatRef: number; barDuration: number };
        response: number;
      };
      getPlaybackStates: {
        params: { trackIds: string[] };
        response: Record<string, PlaybackState>;
      };
      getTempoInfo: {
        params: { trackIds: string[] };
        response: Record<string, { originalBpm: number; tempoRatio: number; masterBpm: number }>;
      };
      openFileDialog: {
        params: Record<string, never>;
        response: string[];
      };
      openDirectoryDialog: {
        params: Record<string, never>;
        response: string;
      };
      scanDirectory: {
        params: { dirPath: string };
        response: void;
      };
      searchLibrary: {
        params: { query: string; sortBy?: string; sortDir?: string };
        response: TrackMetadata[];
      };
      getCuesForTrack: {
        params: { filePath: string };
        response: CuePoint[];
      };
      saveCue: {
        params: { cue: { id: string; filePath: string; label: string; time: number; color: string; active: boolean } };
        response: void;
      };
      deleteCue: {
        params: { cueId: string };
        response: void;
      };
      saveCueAutomation: {
        params: { id: string; cueId: string; type: string; durationBars: number; interpolation: string; startValue: number; endValue: number; targetCueId?: string; targetFilePath?: string };
        response: void;
      };
      deleteCueAutomation: {
        params: { automationId: string };
        response: void;
      };
      setAutomation: {
        params: { trackId: string; param: number; startVal: number; endVal: number; durationSeconds: number; interp: number };
        response: void;
      };
      cancelAutomation: {
        params: { trackId: string; param: number };
        response: void;
      };
      isAutomationActive: {
        params: { trackId: string; param: number };
        response: boolean;
      };
      getAutomationValue: {
        params: { trackId: string; param: number };
        response: number;
      };
      saveCollectionTrack: {
        params: { filePath: string; title: string; artist: string; album: string; genre: string; duration: number; bpm: number; key: string; peaks: Peaks3Band | null; beats: number[] | null };
        response: void;
      };
      getCollectionTrack: {
        params: { filePath: string };
        response: CollectionTrack | null;
      };
      getCollectionTracks: {
        params: Record<string, never>;
        response: CollectionTrack[];
      };
    };
    messages: {
      logToBun: { msg: string };
      automationResult: {
        id: string;
        ok: boolean;
        result?: string;
        error?: string;
      };
    };
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: {
      playbackTick: {
        trackId: string;
        position: number;
        isPlaying: boolean;
        level: number;
        loopStart?: number;
        loopEnd?: number;
        filterValue?: number;
        filterAutomationActive?: boolean;
        volumeAutomationActive?: boolean;
        eqLo?: number;
        eqMid?: number;
        eqHi?: number;
        eqAutomationActive?: boolean;
      };
      scanProgress: {
        current: number;
        total: number;
        file: string;
      };
      trackAnalyzed: {
        trackId: string;
        bpm: number;
        beats: number[];
        peaks: Peaks3Band;
      };
      midiState: {
        selectedTrackId: string | null;
        selectedCueIndex: number;
        connected: boolean;
        deviceName: string | null;
      };
      midiAction: {
        action: string;
        trackId: string | null;
        value: number;
        band?: string;
      };
    };
  }>;
};
