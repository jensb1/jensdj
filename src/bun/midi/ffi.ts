import { dlopen, FFIType, ptr, CString, type Pointer } from "bun:ffi";
import { resolve, dirname } from "path";

// Same dylib as audio — reuse the same path resolution
const candidates = [
  resolve(dirname(process.execPath), "../../../../../native/libdjengine.dylib"),
  resolve(dirname(process.execPath), "../native/libdjengine.dylib"),
  resolve(dirname(process.execPath), "../Resources/native/libdjengine.dylib"),
  resolve(import.meta.dir, "../../../native/libdjengine.dylib"),
  resolve(process.cwd(), "native/libdjengine.dylib"),
];

const libPath = candidates.find((p) => {
  try { return Bun.file(p).size > 0; } catch { return false; }
}) ?? candidates[0]!;

const lib = dlopen(libPath, {
  dj_midi_init: { returns: FFIType.i32 },
  dj_midi_shutdown: { returns: FFIType.void },
  dj_midi_get_source_count: { returns: FFIType.i32 },
  dj_midi_get_source_name: { args: [FFIType.i32], returns: FFIType.ptr },
  dj_midi_open_input: { args: [FFIType.i32], returns: FFIType.i32 },
  dj_midi_close_input: { returns: FFIType.void },
  dj_midi_poll: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  dj_midi_get_dest_count: { returns: FFIType.i32 },
  dj_midi_get_dest_name: { args: [FFIType.i32], returns: FFIType.ptr },
  dj_midi_open_output: { args: [FFIType.i32], returns: FFIType.i32 },
  dj_midi_send: { args: [FFIType.u8, FFIType.u8, FFIType.u8], returns: FFIType.i32 },
  dj_midi_close_output: { returns: FFIType.void },
});

const s = lib.symbols;

const POLL_MAX = 64;

export interface MidiMessage {
  status: number;
  data1: number;
  data2: number;
  channel: number;
}

export const midiInit = (): number => s.dj_midi_init();
export const midiShutdown = (): void => s.dj_midi_shutdown();

export const midiGetSourceCount = (): number => s.dj_midi_get_source_count();
export const midiGetSourceName = (index: number): string => {
  const p = s.dj_midi_get_source_name(index);
  if (!p) return "";
  return new CString(p).toString();
};

export const midiOpenInput = (sourceIndex: number): number =>
  s.dj_midi_open_input(sourceIndex);

export const midiCloseInput = (): void => s.dj_midi_close_input();

export const midiPoll = (): MidiMessage[] => {
  const buf = new Uint8Array(POLL_MAX * 4);
  const bufPtr = ptr(buf) as Pointer;
  const count = s.dj_midi_poll(bufPtr, POLL_MAX);
  if (count <= 0) return [];
  const messages: MidiMessage[] = [];
  for (let i = 0; i < count; i++) {
    const offset = i * 4;
    messages.push({
      status: buf[offset]!,
      data1: buf[offset + 1]!,
      data2: buf[offset + 2]!,
      channel: buf[offset + 3]!,
    });
  }
  return messages;
};

export const midiGetDestCount = (): number => s.dj_midi_get_dest_count();
export const midiGetDestName = (index: number): string => {
  const p = s.dj_midi_get_dest_name(index);
  if (!p) return "";
  return new CString(p).toString();
};

export const midiOpenOutput = (destIndex: number): number =>
  s.dj_midi_open_output(destIndex);

export const midiSend = (status: number, data1: number, data2: number): number =>
  s.dj_midi_send(status, data1, data2);

export const midiCloseOutput = (): void => s.dj_midi_close_output();
