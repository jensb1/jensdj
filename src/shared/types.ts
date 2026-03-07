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

// Cue / marker point
export type ConnectionAction = 'start' | 'stop' | 'loop';

export interface CueConnection {
  id: string;              // persistent UUID
  cueId: string;           // target cue persistent UUID
  targetFilePath: string;  // stable file reference for auto-load
  action: ConnectionAction;
}

export interface CuePoint {
  id: string;              // persistent UUID
  filePath: string;        // stable track identifier
  trackId: string;         // runtime-only, set when track is loaded
  label: string;           // 'A', 'B', 'C', 'D', ...
  time: number;            // seconds, snapped to beat
  color: string;
  active: boolean;
  connections: CueConnection[];  // linked cues on other tracks
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
      saveCueConnection: {
        params: { id: string; sourceCueId: string; targetCueId: string; targetFilePath: string; action: string };
        response: void;
      };
      deleteCueConnection: {
        params: { connectionId: string };
        response: void;
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
