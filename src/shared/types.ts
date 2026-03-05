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
      cancelScheduledStart: {
        params: { trackId: string };
        response: void;
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
    };
    messages: {
      logToBun: { msg: string };
    };
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: {
      playbackTick: {
        trackId: string;
        position: number;
        level: number;
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
    };
  }>;
};
