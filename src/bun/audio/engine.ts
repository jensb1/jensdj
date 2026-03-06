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
  djGetOriginalBpm,
  djScheduleSyncPlay,
  djSyncStart,
  djCancelScheduledStart,
  djSetLoop,
  djClearLoop,
  djIsLooping,
  djGetPeaks3Band,
  djDetectBpm,
  djDetectBeats,
} from "./ffi.ts";
import type {
  OutputDevice,
  LoadedTrack,
  TrackMetadata,
  EQSettings,
  Peaks3Band,
} from "../../shared/types.ts";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

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
const CACHE_DIR = join(homedir(), ".jensdj", "cache");

interface AnalysisCache {
  peaks: Peaks3Band;
  bpm: number;
  beats: number[];
}

function cacheKey(filePath: string): string {
  return createHash("md5").update(filePath).digest("hex");
}

function readCache(filePath: string): AnalysisCache | null {
  try {
    const p = join(CACHE_DIR, cacheKey(filePath) + ".json");
    const f = Bun.file(p);
    if (f.size === 0) return null;
    // Bun.file().text() is async but we need sync — use require("fs")
    const text = require("fs").readFileSync(p, "utf-8");
    const data = JSON.parse(text);
    if (data?.peaks?.low && data?.bpm !== undefined && data?.beats) return data;
    return null;
  } catch { return null; }
}

function writeCache(filePath: string, data: AnalysisCache): void {
  try {
    const dir = CACHE_DIR;
    try { require("fs").mkdirSync(dir, { recursive: true }); } catch {}
    const p = join(dir, cacheKey(filePath) + ".json");
    Bun.write(p, JSON.stringify(data));
  } catch (e) {
    console.warn("[Cache] Write failed:", e);
  }
}

export class AudioEngine {
  private tracks = new Map<string, InternalTrack>();
  private engines = new Map<number, NativePtr>();
  private nextId = 1;
  private initialized = false;
  private _masterBpm = 0;
  private _activeLoops = new Map<string, { start: number; end: number }>();

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
      // Auto-sync to master BPM if set
      if (this._masterBpm > 0) {
        djSetTempo(soundPtr, this._masterBpm / analysis.bpm);
      }
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
    // Check cache first
    const cached = readCache(filePath);
    if (cached) {
      console.log("[AudioEngine] Cache hit:", filePath);
      return cached;
    }

    console.log("[AudioEngine] Analyzing (no cache):", filePath);
    const peaks3 = djGetPeaks3Band(filePath, NUM_PEAKS);
    const peaks = peaks3 ?? { low: Array(NUM_PEAKS).fill(0), mid: Array(NUM_PEAKS).fill(0), high: Array(NUM_PEAKS).fill(0) };
    const bpm = djDetectBpm(filePath);
    const beatsBuf = djDetectBeats(filePath, MAX_BEATS);
    const beats = Array.from(beatsBuf);

    // Write to cache
    writeCache(filePath, { peaks, bpm, beats });

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

  syncStart(
    targetTrackId: string,
    targetBeat: number,
    sourceTrackId: string,
    sourceBeat: number,
    barDuration: number,
    preserveTransport = false
  ): boolean {
    const target = this.tracks.get(targetTrackId);
    const source = this.tracks.get(sourceTrackId);
    if (!target || !source) return false;

    const result = djSyncStart(
      target.soundPtr, targetBeat,
      source.soundPtr, sourceBeat,
      barDuration,
      preserveTransport
    );
    console.log(
      `[AudioEngine] syncStart: ${sourceTrackId}@beat${sourceBeat.toFixed(2)}s → ${targetTrackId}@beat${targetBeat.toFixed(2)}s bar=${barDuration.toFixed(3)}s = ${result === 0 ? "OK" : "FAIL"}`
    );
    return result === 0;
  }

  cancelScheduledStart(trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    djCancelScheduledStart(track.soundPtr);
  }

  setLoop(trackId: string, startSec: number, endSec: number): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    djSetLoop(track.soundPtr, startSec, endSec);
    this._activeLoops.set(trackId, { start: startSec, end: endSec });
  }

  clearLoop(trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    djClearLoop(track.soundPtr);
    this._activeLoops.delete(trackId);
  }

  getActiveLoop(trackId: string): { start: number; end: number } | null {
    return this._activeLoops.get(trackId) ?? null;
  }

  isLooping(trackId: string): boolean {
    const track = this.tracks.get(trackId);
    if (!track) return false;
    return djIsLooping(track.soundPtr);
  }

  setMasterBpm(bpm: number): void {
    this._masterBpm = bpm;
    for (const [, track] of this.tracks) {
      const originalBpm = djGetOriginalBpm(track.soundPtr);
      if (originalBpm > 0 && bpm > 0) {
        djSetTempo(track.soundPtr, bpm / originalBpm);
      } else if (bpm === 0) {
        djSetTempo(track.soundPtr, 1.0); // Reset to original tempo
      }
    }
  }

  getOriginalBpm(trackId: string): number {
    const track = this.tracks.get(trackId);
    if (!track) return 0;
    return djGetOriginalBpm(track.soundPtr);
  }

  getAllTrackIds(): string[] {
    return Array.from(this.tracks.keys());
  }
}
