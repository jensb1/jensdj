import { dlopen, FFIType, ptr, CString, type Pointer } from "bun:ffi";
import { resolve, dirname } from "path";

// In dev: import.meta.dir is src/bun/audio/, dylib is at native/
// In bundled app: the dylib should be alongside the app bundle
// We try the project root first, then fall back to relative paths
// In dev: execPath is at build/dev-macos-arm64/JensDJ-dev.app/Contents/MacOS/bun
// Project root is 5 levels up from MacOS/
const candidates = [
  // Dev mode: project root's native/
  resolve(dirname(process.execPath), "../../../../../native/libdjengine.dylib"),
  // Bundled app: Contents/native/
  resolve(dirname(process.execPath), "../native/libdjengine.dylib"),
  // Bundled app: Contents/Resources/native/
  resolve(dirname(process.execPath), "../Resources/native/libdjengine.dylib"),
  // Fallback: relative from source
  resolve(import.meta.dir, "../../../native/libdjengine.dylib"),
  resolve(process.cwd(), "native/libdjengine.dylib"),
];

const libPath = candidates.find((p) => {
  try { return Bun.file(p).size > 0; } catch { return false; }
}) ?? candidates[0]!;

const lib = dlopen(libPath, {
  dj_init: { returns: FFIType.i32 },
  dj_shutdown: { returns: FFIType.void },
  dj_get_device_count: { returns: FFIType.i32 },
  dj_get_device_name: { args: [FFIType.i32], returns: FFIType.ptr },
  dj_get_device_channels: { args: [FFIType.i32], returns: FFIType.i32 },
  dj_create_engine: { args: [FFIType.i32], returns: FFIType.ptr },
  dj_destroy_engine: { args: [FFIType.ptr], returns: FFIType.void },
  dj_load_sound: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
  dj_unload_sound: { args: [FFIType.ptr], returns: FFIType.void },
  dj_play: { args: [FFIType.ptr], returns: FFIType.i32 },
  dj_pause: { args: [FFIType.ptr], returns: FFIType.i32 },
  dj_stop: { args: [FFIType.ptr], returns: FFIType.i32 },
  dj_seek: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.i32 },
  dj_get_position: { args: [FFIType.ptr], returns: FFIType.f32 },
  dj_get_duration: { args: [FFIType.ptr], returns: FFIType.f32 },
  dj_is_playing: { args: [FFIType.ptr], returns: FFIType.i32 },
  dj_set_volume: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
  dj_set_eq: {
    args: [FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.f32],
    returns: FFIType.void,
  },
  dj_get_eq_lo: { args: [FFIType.ptr], returns: FFIType.f32 },
  dj_get_eq_mid: { args: [FFIType.ptr], returns: FFIType.f32 },
  dj_get_eq_hi: { args: [FFIType.ptr], returns: FFIType.f32,
  },
  dj_get_level: { args: [FFIType.ptr], returns: FFIType.f32 },
  dj_set_tempo: {
    args: [FFIType.ptr, FFIType.f32],
    returns: FFIType.void,
  },
  dj_get_tempo: {
    args: [FFIType.ptr],
    returns: FFIType.f32,
  },
  dj_set_original_bpm: {
    args: [FFIType.ptr, FFIType.f32],
    returns: FFIType.void,
  },
  dj_get_original_bpm: {
    args: [FFIType.ptr],
    returns: FFIType.f32,
  },
  dj_schedule_sync_play: {
    args: [FFIType.ptr, FFIType.f32, FFIType.ptr, FFIType.f32],
    returns: FFIType.i32,
  },
  dj_sync_start: {
    args: [FFIType.ptr, FFIType.f32, FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.i32],
    returns: FFIType.i32,
  },
  dj_cancel_scheduled_start: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  dj_get_sync_diff: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.f32, FFIType.f32],
    returns: FFIType.f32,
  },
  dj_get_track_sync_diff: {
    args: [FFIType.ptr],
    returns: FFIType.f32,
  },
  dj_set_global_clock: {
    args: [FFIType.f32],
    returns: FFIType.void,
  },
  dj_align_global_clock: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  dj_get_global_phase: {
    returns: FFIType.f32,
  },
  dj_set_beat_ref: {
    args: [FFIType.ptr, FFIType.f32],
    returns: FFIType.void,
  },
  dj_get_beat_ref: {
    args: [FFIType.ptr],
    returns: FFIType.f32,
  },
  dj_set_loop: {
    args: [FFIType.ptr, FFIType.f32, FFIType.f32],
    returns: FFIType.void,
  },
  dj_clear_loop: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  dj_is_looping: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  dj_set_filter: {
    args: [FFIType.ptr, FFIType.f32],
    returns: FFIType.void,
  },
  dj_get_filter: {
    args: [FFIType.ptr],
    returns: FFIType.f32,
  },
  dj_set_automation: {
    args: [FFIType.ptr, FFIType.i32, FFIType.f32, FFIType.f32, FFIType.f32, FFIType.i32],
    returns: FFIType.void,
  },
  dj_cancel_automation: {
    args: [FFIType.ptr, FFIType.i32],
    returns: FFIType.void,
  },
  dj_get_automation_value: {
    args: [FFIType.ptr, FFIType.i32],
    returns: FFIType.f32,
  },
  dj_is_automation_active: {
    args: [FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  dj_get_peaks: {
    args: [FFIType.cstring, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  dj_get_peaks_3band: {
    args: [FFIType.cstring, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  dj_detect_bpm: { args: [FFIType.cstring], returns: FFIType.f32 },
  dj_detect_beats: {
    args: [FFIType.cstring, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  dj_pull_frames: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  dj_find_transients: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  dj_get_sample_rate: { args: [FFIType.ptr], returns: FFIType.i32 },
  dj_set_beats: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.void },
  dj_sync_play: { args: [FFIType.ptr, FFIType.ptr, FFIType.f32], returns: FFIType.i32 },
  dj_set_master_bpm: { args: [FFIType.f32], returns: FFIType.void },
  dj_get_master_bpm: { returns: FFIType.f32 },
  dj_register_track: { args: [FFIType.ptr], returns: FFIType.void },
  dj_unregister_track: { args: [FFIType.ptr], returns: FFIType.void },
  dj_free_beat_grid: { args: [FFIType.ptr], returns: FFIType.void },
  dj_get_output_frame_count: { args: [FFIType.ptr], returns: FFIType.u64 },
  dj_get_read_cursor: { args: [FFIType.ptr], returns: FFIType.u64 },
  dj_get_rb_latency: { args: [FFIType.ptr], returns: FFIType.i32 },
  dj_get_rb_available: { args: [FFIType.ptr], returns: FFIType.i32 },
});

// Raw symbols - use typed wrappers below instead
const s = lib.symbols;

// Opaque handle type for FFI pointers (runtime: number, but TS-branded)
export type NativePtr = Pointer & { __brand: "native" };

function asPtr(p: Pointer | null): NativePtr {
  return p as unknown as NativePtr;
}

function cstr(str: string): Uint8Array {
  return new TextEncoder().encode(str + "\0");
}

function floatBuf(count: number): { buffer: Float32Array; ptr: NativePtr } {
  const buffer = new Float32Array(count);
  return { buffer, ptr: ptr(buffer) as unknown as NativePtr };
}

// --- Typed wrapper API ---

export const djInit = (): number => s.dj_init();
export const djShutdown = (): void => s.dj_shutdown();
export const djGetDeviceCount = (): number => s.dj_get_device_count();

export const djGetDeviceName = (index: number): string => {
  const p = s.dj_get_device_name(index);
  if (!p) return "";
  return new CString(p).toString();
};

export const djGetDeviceChannels = (index: number): number =>
  s.dj_get_device_channels(index);

export const djCreateEngine = (deviceIndex: number): NativePtr | null => {
  const p = s.dj_create_engine(deviceIndex);
  return p ? asPtr(p) : null;
};

export const djDestroyEngine = (engine: NativePtr): void => {
  s.dj_destroy_engine(engine as unknown as Pointer);
};

export const djLoadSound = (
  engine: NativePtr,
  filepath: string
): NativePtr | null => {
  const p = s.dj_load_sound(
    engine as unknown as Pointer,
    cstr(filepath)
  );
  return p ? asPtr(p) : null;
};

export const djUnloadSound = (sound: NativePtr): void => {
  s.dj_unload_sound(sound as unknown as Pointer);
};

export const djPlay = (sound: NativePtr): number =>
  s.dj_play(sound as unknown as Pointer);

export const djPause = (sound: NativePtr): number =>
  s.dj_pause(sound as unknown as Pointer);

export const djStop = (sound: NativePtr): number =>
  s.dj_stop(sound as unknown as Pointer);

export const djSeek = (sound: NativePtr, seconds: number): number =>
  s.dj_seek(sound as unknown as Pointer, seconds);

export const djGetPosition = (sound: NativePtr): number =>
  s.dj_get_position(sound as unknown as Pointer);

export const djGetDuration = (sound: NativePtr): number =>
  s.dj_get_duration(sound as unknown as Pointer);

export const djIsPlaying = (sound: NativePtr): boolean =>
  s.dj_is_playing(sound as unknown as Pointer) === 1;

export const djSetVolume = (sound: NativePtr, volume: number): void => {
  s.dj_set_volume(sound as unknown as Pointer, volume);
};

export const djSetEQ = (
  sound: NativePtr,
  lo: number,
  mid: number,
  hi: number
): void => {
  s.dj_set_eq(sound as unknown as Pointer, lo, mid, hi);
};

export const djGetEqLo = (sound: NativePtr): number =>
  s.dj_get_eq_lo(sound as unknown as Pointer);
export const djGetEqMid = (sound: NativePtr): number =>
  s.dj_get_eq_mid(sound as unknown as Pointer);
export const djGetEqHi = (sound: NativePtr): number =>
  s.dj_get_eq_hi(sound as unknown as Pointer);

export const djGetLevel = (sound: NativePtr): number =>
  s.dj_get_level(sound as unknown as Pointer);

export const djSetTempo = (sound: NativePtr, ratio: number): void => {
  s.dj_set_tempo(sound as unknown as Pointer, ratio);
};

export const djGetTempo = (sound: NativePtr): number =>
  s.dj_get_tempo(sound as unknown as Pointer);

export const djSetOriginalBpm = (sound: NativePtr, bpm: number): void => {
  s.dj_set_original_bpm(sound as unknown as Pointer, bpm);
};

export const djGetOriginalBpm = (sound: NativePtr): number =>
  s.dj_get_original_bpm(sound as unknown as Pointer);

export const djScheduleSyncPlay = (
  targetSound: NativePtr,
  targetSeconds: number,
  sourceSound: NativePtr,
  sourceSeconds: number
): number =>
  s.dj_schedule_sync_play(
    targetSound as unknown as Pointer,
    targetSeconds,
    sourceSound as unknown as Pointer,
    sourceSeconds
  );

export const djSyncStart = (
  targetSound: NativePtr,
  targetBeat: number,
  sourceSound: NativePtr,
  sourceBeat: number,
  barDuration: number,
  preserveTransport: boolean
): number =>
  s.dj_sync_start(
    targetSound as unknown as Pointer,
    targetBeat,
    sourceSound as unknown as Pointer,
    sourceBeat,
    barDuration,
    preserveTransport ? 1 : 0
  );

export const djCancelScheduledStart = (sound: NativePtr): number =>
  s.dj_cancel_scheduled_start(sound as unknown as Pointer);

export const djGetSyncDiff = (sound1: NativePtr, sound2: NativePtr, beatRef: number, barDuration: number): number =>
  s.dj_get_sync_diff(sound1 as unknown as Pointer, sound2 as unknown as Pointer, beatRef, barDuration);

export const djGetTrackSyncDiff = (sound: NativePtr): number =>
  s.dj_get_track_sync_diff(sound as unknown as Pointer);

export const djSetGlobalClock = (barDuration: number): void => {
  s.dj_set_global_clock(barDuration);
};

export const djAlignGlobalClock = (sound: NativePtr): void => {
  s.dj_align_global_clock(sound as unknown as Pointer);
};

export const djGetGlobalPhase = (): number =>
  s.dj_get_global_phase();

export const djSetBeatRef = (sound: NativePtr, beatRef: number): void => {
  s.dj_set_beat_ref(sound as unknown as Pointer, beatRef);
};

export const djGetBeatRef = (sound: NativePtr): number =>
  s.dj_get_beat_ref(sound as unknown as Pointer);

export const djSetLoop = (sound: NativePtr, startSec: number, endSec: number): void => {
  s.dj_set_loop(sound as unknown as Pointer, startSec, endSec);
};

export const djClearLoop = (sound: NativePtr): void => {
  s.dj_clear_loop(sound as unknown as Pointer);
};

export const djIsLooping = (sound: NativePtr): boolean =>
  s.dj_is_looping(sound as unknown as Pointer) === 1;

export const djSetFilter = (sound: NativePtr, value: number): void => {
  s.dj_set_filter(sound as unknown as Pointer, value);
};

export const djGetFilter = (sound: NativePtr): number =>
  s.dj_get_filter(sound as unknown as Pointer);

// Automation constants
export const DJ_PARAM_FILTER = 0;
export const DJ_PARAM_VOLUME = 1;
export const DJ_PARAM_EQ_LO = 2;
export const DJ_PARAM_EQ_MID = 3;
export const DJ_PARAM_EQ_HI = 4;
export const DJ_INTERP_LINEAR = 0;
export const DJ_INTERP_EASE_IN = 1;
export const DJ_INTERP_EASE_OUT = 2;

export const djSetAutomation = (
  sound: NativePtr, param: number, startVal: number, endVal: number,
  durationSeconds: number, interp: number
): void => {
  s.dj_set_automation(sound as unknown as Pointer, param, startVal, endVal, durationSeconds, interp);
};

export const djCancelAutomation = (sound: NativePtr, param: number): void => {
  s.dj_cancel_automation(sound as unknown as Pointer, param);
};

export const djGetAutomationValue = (sound: NativePtr, param: number): number =>
  s.dj_get_automation_value(sound as unknown as Pointer, param);

export const djIsAutomationActive = (sound: NativePtr, param: number): boolean =>
  s.dj_is_automation_active(sound as unknown as Pointer, param) === 1;

export const djGetPeaks = (
  filepath: string,
  numPoints: number
): Float32Array | null => {
  const { buffer, ptr: bufPtr } = floatBuf(numPoints);
  const result = s.dj_get_peaks(
    cstr(filepath),
    bufPtr as unknown as Pointer,
    numPoints
  );
  return result === 0 ? buffer : null;
};

export interface Peaks3Band {
  low: number[];
  mid: number[];
  high: number[];
}

export const djGetPeaks3Band = (
  filepath: string,
  numPoints: number
): Peaks3Band | null => {
  const { buffer, ptr: bufPtr } = floatBuf(numPoints * 3);
  const result = s.dj_get_peaks_3band(
    cstr(filepath),
    bufPtr as unknown as Pointer,
    numPoints
  );
  if (result !== 0) return null;
  const low: number[] = new Array(numPoints);
  const mid: number[] = new Array(numPoints);
  const high: number[] = new Array(numPoints);
  for (let i = 0; i < numPoints; i++) {
    low[i] = buffer[i * 3]!;
    mid[i] = buffer[i * 3 + 1]!;
    high[i] = buffer[i * 3 + 2]!;
  }
  return { low, mid, high };
};

export const djDetectBpm = (filepath: string): number =>
  s.dj_detect_bpm(cstr(filepath));

export const djDetectBeats = (
  filepath: string,
  maxBeats: number
): Float32Array => {
  const { buffer, ptr: bufPtr } = floatBuf(maxBeats);
  const count = s.dj_detect_beats(
    cstr(filepath),
    bufPtr as unknown as Pointer,
    maxBeats
  );
  return buffer.subarray(0, count);
};

// Sync engine functions
export const djSetBeats = (sound: NativePtr, beats: Float32Array): void => {
  s.dj_set_beats(sound as unknown as Pointer, ptr(beats) as unknown as Pointer, beats.length);
};

export const djSyncPlay = (target: NativePtr, source: NativePtr, targetAnchorPos: number = -1): number =>
  s.dj_sync_play(target as unknown as Pointer, source as unknown as Pointer, targetAnchorPos);

export const djSetMasterBpm = (bpm: number): void => {
  s.dj_set_master_bpm(bpm);
};

export const djGetMasterBpm = (): number =>
  s.dj_get_master_bpm();

export const djRegisterTrack = (sound: NativePtr): void => {
  s.dj_register_track(sound as unknown as Pointer);
};

export const djUnregisterTrack = (sound: NativePtr): void => {
  s.dj_unregister_track(sound as unknown as Pointer);
};

export const djFreeBeatGrid = (sound: NativePtr): void => {
  s.dj_free_beat_grid(sound as unknown as Pointer);
};

// Diagnostic / test functions
export function djGetOutputFrameCount(sound: NativePtr): number {
  return Number(s.dj_get_output_frame_count(sound as unknown as Pointer));
}
export function djGetReadCursor(sound: NativePtr): number {
  return Number(s.dj_get_read_cursor(sound as unknown as Pointer));
}
export function djGetRbLatency(sound: NativePtr): number {
  return s.dj_get_rb_latency(sound as unknown as Pointer);
}
export function djGetRbAvailable(sound: NativePtr): number {
  return s.dj_get_rb_available(sound as unknown as Pointer);
}

export function djPullFrames(sound: NativePtr, buffer: Float32Array): number {
  return s.dj_pull_frames(
    sound as unknown as Pointer,
    ptr(buffer) as unknown as Pointer,
    buffer.length / 2  // stereo: num_frames = buffer_length / channels
  );
}

export function djFindTransients(
  pcm: Float32Array,
  sampleRate: number,
  maxTransients: number
): Float32Array {
  const { buffer: outBuf, ptr: outPtr } = floatBuf(maxTransients);
  const count = s.dj_find_transients(
    ptr(pcm) as unknown as Pointer,
    pcm.length,
    sampleRate,
    outPtr as unknown as Pointer,
    maxTransients
  );
  return outBuf.subarray(0, count);
}

export function djGetSampleRate(sound: NativePtr): number {
  return s.dj_get_sample_rate(sound as unknown as Pointer);
}
