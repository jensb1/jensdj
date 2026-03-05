import {
  type NativePtr,
  djInit,
  djShutdown,
  djGetDeviceCount,
  djGetDeviceName,
  djGetDeviceChannels,
  djCreateEngine,
  djDestroyEngine,
  djLoadSound,
  djUnloadSound,
  djPlay,
  djPause,
  djStop,
  djSeek,
  djGetPosition,
  djGetDuration,
  djIsPlaying,
  djSetVolume,
  djSetEQ,
  djGetLevel,
  djSetTempo,
  djGetTempo,
  djSetOriginalBpm,
  djScheduleSyncPlay,
  djCancelScheduledStart,
  djGetPeaks3Band,
  djDetectBpm,
  djDetectBeats,
} from "./ffi.ts";
import type {
  OutputDevice,
  LoadedTrack,
  TrackMetadata,
  EQSettings,
} from "../../shared/types.ts";

interface InternalTrack {
  id: string;
  filePath: string;
  enginePtr: NativePtr;
  soundPtr: NativePtr;
  deviceIndex: number;
  metadata: TrackMetadata;
}

const NUM_PEAKS = 50000;
const MAX_BEATS = 4000;

export class AudioEngine {
  private tracks = new Map<string, InternalTrack>();
  private engines = new Map<number, NativePtr>();
  private nextId = 1;
  private initialized = false;

  init(): boolean {
    if (this.initialized) return true;
    const result = djInit();
    this.initialized = result === 0;
    if (this.initialized) {
      console.log("[AudioEngine] Initialized");
      const devices = this.getDevices();
      for (const d of devices) {
        console.log(`  [${d.id}] ${d.name} (${d.channels}ch)`);
      }
    } else {
      console.error("[AudioEngine] Failed to initialize:", result);
    }
    return this.initialized;
  }

  shutdown(): void {
    for (const track of this.tracks.values()) {
      djUnloadSound(track.soundPtr);
    }
    this.tracks.clear();
    for (const enginePtr of this.engines.values()) {
      djDestroyEngine(enginePtr);
    }
    this.engines.clear();
    djShutdown();
    this.initialized = false;
  }

  getDevices(): OutputDevice[] {
    const count = djGetDeviceCount();
    const devices: OutputDevice[] = [];
    for (let i = 0; i < count; i++) {
      devices.push({
        id: i,
        name: djGetDeviceName(i),
        channels: djGetDeviceChannels(i),
      });
    }
    return devices;
  }

  private getOrCreateEngine(deviceIndex: number): NativePtr {
    const existing = this.engines.get(deviceIndex);
    if (existing) return existing;
    const enginePtr = djCreateEngine(deviceIndex);
    if (!enginePtr) {
      throw new Error(`Failed to create engine for device ${deviceIndex}`);
    }
    this.engines.set(deviceIndex, enginePtr);
    return enginePtr;
  }

  loadTrack(filePath: string, metadata: TrackMetadata): LoadedTrack {
    const id = `track_${this.nextId++}`;
    const deviceIndex = -1;
    const enginePtr = this.getOrCreateEngine(deviceIndex);

    const soundPtr = djLoadSound(enginePtr, filePath);
    if (!soundPtr) {
      throw new Error(`Failed to load sound: ${filePath}`);
    }

    const duration = djGetDuration(soundPtr);

    const track: InternalTrack = {
      id,
      filePath,
      enginePtr,
      soundPtr,
      deviceIndex,
      metadata: { ...metadata, duration },
    };
    this.tracks.set(id, track);

    const analysis = this.analyze(filePath);

    // Store BPM in native engine for auto-sync
    if (analysis.bpm > 0) {
      djSetOriginalBpm(soundPtr, analysis.bpm);
    }

    return {
      id,
      filePath,
      metadata: track.metadata,
      peaks: analysis.peaks,
      bpm: analysis.bpm,
      beats: analysis.beats,
      duration,
    };
  }

  private analyze(filePath: string) {
    const peaks3 = djGetPeaks3Band(filePath, NUM_PEAKS);
    const peaks = peaks3 ?? { low: Array(NUM_PEAKS).fill(0), mid: Array(NUM_PEAKS).fill(0), high: Array(NUM_PEAKS).fill(0) };
    const bpm = djDetectBpm(filePath);
    const beatsBuf = djDetectBeats(filePath, MAX_BEATS);
    const beats = Array.from(beatsBuf);
    return { peaks, bpm, beats };
  }

  unloadTrack(trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    djUnloadSound(track.soundPtr);
    this.tracks.delete(trackId);
  }

  play(trackId: string, fromTime?: number): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    if (fromTime !== undefined) djSeek(track.soundPtr, fromTime);
    djPlay(track.soundPtr);
  }

  pause(trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    djPause(track.soundPtr);
  }

  stop(trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    djStop(track.soundPtr);
  }

  seek(trackId: string, seconds: number): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    djSeek(track.soundPtr, seconds);
  }

  setVolume(trackId: string, volume: number): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    djSetVolume(track.soundPtr, volume);
  }

  setEQ(trackId: string, eq: EQSettings): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    djSetEQ(track.soundPtr, eq.lo, eq.mid, eq.hi);
  }

  getPosition(trackId: string): number {
    const track = this.tracks.get(trackId);
    if (!track) return 0;
    return djGetPosition(track.soundPtr);
  }

  isPlaying(trackId: string): boolean {
    const track = this.tracks.get(trackId);
    if (!track) return false;
    return djIsPlaying(track.soundPtr);
  }

  getLevel(trackId: string): number {
    const track = this.tracks.get(trackId);
    if (!track) return 0;
    return djGetLevel(track.soundPtr);
  }

  setOutputDevice(trackId: string, deviceId: number): void {
    const track = this.tracks.get(trackId);
    if (!track || track.deviceIndex === deviceId) return;

    const newEnginePtr = this.getOrCreateEngine(deviceId);
    const newSoundPtr = djLoadSound(newEnginePtr, track.filePath);
    if (!newSoundPtr) {
      console.error(`Failed to move track to device ${deviceId}`);
      return;
    }

    const pos = djGetPosition(track.soundPtr);
    const wasPlaying = djIsPlaying(track.soundPtr);

    djUnloadSound(track.soundPtr);
    track.soundPtr = newSoundPtr;
    track.enginePtr = newEnginePtr;
    track.deviceIndex = deviceId;

    djSeek(newSoundPtr, pos);
    if (wasPlaying) djPlay(newSoundPtr);
  }

  scheduleSyncPlay(
    targetTrackId: string,
    targetBeatSeconds: number,
    sourceTrackId: string,
    sourceBeatSeconds: number
  ): boolean {
    const target = this.tracks.get(targetTrackId);
    const source = this.tracks.get(sourceTrackId);
    if (!target || !source) return false;

    const result = djScheduleSyncPlay(
      target.soundPtr,
      targetBeatSeconds,
      source.soundPtr,
      sourceBeatSeconds
    );
    console.log(
      `[AudioEngine] scheduleSyncPlay: ${sourceTrackId}@${sourceBeatSeconds.toFixed(2)}s → ${targetTrackId}@${targetBeatSeconds.toFixed(2)}s = ${result === 0 ? "OK" : "FAIL"}`
    );
    return result === 0;
  }

  cancelScheduledStart(trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    djCancelScheduledStart(track.soundPtr);
  }

  getAllTrackIds(): string[] {
    return Array.from(this.tracks.keys());
  }
}
