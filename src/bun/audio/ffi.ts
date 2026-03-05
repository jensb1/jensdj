import { dlopen, FFIType, ptr, CString, type Pointer } from "bun:ffi";
import { resolve, dirname } from "path";

// In dev: import.meta.dir is src/bun/audio/, dylib is at native/
// In bundled app: the dylib should be alongside the app bundle
// We try the project root first, then fall back to relative paths
const candidates = [
  resolve(import.meta.dir, "../../../native/libdjengine.dylib"),
  resolve(import.meta.dir, "../../native/libdjengine.dylib"),
  resolve(import.meta.dir, "../native/libdjengine.dylib"),
  resolve(dirname(process.execPath), "../native/libdjengine.dylib"),
  resolve(dirname(process.execPath), "../Resources/native/libdjengine.dylib"),
  resolve(dirname(process.execPath), "../Resources/app/native/libdjengine.dylib"),
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
  dj_cancel_scheduled_start: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  dj_get_peaks: {
    args: [FFIType.cstring, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  dj_detect_bpm: { args: [FFIType.cstring], returns: FFIType.f32 },
  dj_detect_beats: {
    args: [FFIType.cstring, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
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

export const djCancelScheduledStart = (sound: NativePtr): number =>
  s.dj_cancel_scheduled_start(sound as unknown as Pointer);

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
