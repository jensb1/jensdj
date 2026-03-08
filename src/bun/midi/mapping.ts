import { join } from "path";
import { homedir } from "os";

export interface MidiMapEntry {
  channel: number;
  type: "cc" | "note";
  number: number;
  encoding: "absolute" | "relative" | "toggle";
  action: string;
  trackIndex?: number; // for fixed per-track controls (0-3)
}

export interface MidiMapping {
  deviceName: string;
  channel: number;
  entries: MidiMapEntry[];
}

const MAPPING_PATH = join(homedir(), ".jensdj", "midi-mapping.json");

export function getDefaultK2Mapping(): MidiMapping {
  const ch = 14; // MIDI channel 15 = index 14

  const entries: MidiMapEntry[] = [
    // Faders 1-4: volume per track
    { channel: ch, type: "cc", number: 16, encoding: "absolute", action: "volume", trackIndex: 0 },
    { channel: ch, type: "cc", number: 17, encoding: "absolute", action: "volume", trackIndex: 1 },
    { channel: ch, type: "cc", number: 18, encoding: "absolute", action: "volume", trackIndex: 2 },
    { channel: ch, type: "cc", number: 19, encoding: "absolute", action: "volume", trackIndex: 3 },

    // Pot row 1 (CC 4-7): hi EQ per track
    { channel: ch, type: "cc", number: 4, encoding: "absolute", action: "eqHi", trackIndex: 0 },
    { channel: ch, type: "cc", number: 5, encoding: "absolute", action: "eqHi", trackIndex: 1 },
    { channel: ch, type: "cc", number: 6, encoding: "absolute", action: "eqHi", trackIndex: 2 },
    { channel: ch, type: "cc", number: 7, encoding: "absolute", action: "eqHi", trackIndex: 3 },

    // Pot row 2 (CC 8-11): mid EQ per track
    { channel: ch, type: "cc", number: 8, encoding: "absolute", action: "eqMid", trackIndex: 0 },
    { channel: ch, type: "cc", number: 9, encoding: "absolute", action: "eqMid", trackIndex: 1 },
    { channel: ch, type: "cc", number: 10, encoding: "absolute", action: "eqMid", trackIndex: 2 },
    { channel: ch, type: "cc", number: 11, encoding: "absolute", action: "eqMid", trackIndex: 3 },

    // Pot row 3 (CC 12-15): lo EQ per track
    { channel: ch, type: "cc", number: 12, encoding: "absolute", action: "eqLo", trackIndex: 0 },
    { channel: ch, type: "cc", number: 13, encoding: "absolute", action: "eqLo", trackIndex: 1 },
    { channel: ch, type: "cc", number: 14, encoding: "absolute", action: "eqLo", trackIndex: 2 },
    { channel: ch, type: "cc", number: 15, encoding: "absolute", action: "eqLo", trackIndex: 3 },

    // Encoder CC 20: select cue point on selected track
    { channel: ch, type: "cc", number: 20, encoding: "relative", action: "selectCue" },
    // Encoder CC 20 press (note 13): activate cue / enter cue select mode
    { channel: ch, type: "note", number: 13, encoding: "toggle", action: "activateCue" },

    // Encoder CC 21: move preview cursor by full bars
    { channel: ch, type: "cc", number: 21, encoding: "relative", action: "jumpPreview" },
    // Encoder CC 21 press (note 14): add cue point at current position
    { channel: ch, type: "note", number: 14, encoding: "toggle", action: "addCue" },

    // Notes 24-27: select track 1-4 directly
    { channel: ch, type: "note", number: 24, encoding: "toggle", action: "selectTrack", trackIndex: 0 },
    { channel: ch, type: "note", number: 25, encoding: "toggle", action: "selectTrack", trackIndex: 1 },
    { channel: ch, type: "note", number: 26, encoding: "toggle", action: "selectTrack", trackIndex: 2 },
    { channel: ch, type: "note", number: 27, encoding: "toggle", action: "selectTrack", trackIndex: 3 },

    // Button row 1 (A-D): play/pause per track
    { channel: ch, type: "note", number: 36, encoding: "toggle", action: "play", trackIndex: 0 },
    { channel: ch, type: "note", number: 37, encoding: "toggle", action: "play", trackIndex: 1 },
    { channel: ch, type: "note", number: 38, encoding: "toggle", action: "play", trackIndex: 2 },
    { channel: ch, type: "note", number: 39, encoding: "toggle", action: "play", trackIndex: 3 },

    // Button row 2 (E-H): set cue per track
    { channel: ch, type: "note", number: 32, encoding: "toggle", action: "cue", trackIndex: 0 },
    { channel: ch, type: "note", number: 33, encoding: "toggle", action: "cue", trackIndex: 1 },
    { channel: ch, type: "note", number: 34, encoding: "toggle", action: "cue", trackIndex: 2 },
    { channel: ch, type: "note", number: 35, encoding: "toggle", action: "cue", trackIndex: 3 },

    // Button row 3 (I-L): loop per track
    { channel: ch, type: "note", number: 28, encoding: "toggle", action: "loop", trackIndex: 0 },
    { channel: ch, type: "note", number: 29, encoding: "toggle", action: "loop", trackIndex: 1 },
    { channel: ch, type: "note", number: 30, encoding: "toggle", action: "loop", trackIndex: 2 },
    { channel: ch, type: "note", number: 31, encoding: "toggle", action: "loop", trackIndex: 3 },
  ];

  return {
    deviceName: "XONE:K2",
    channel: ch,
    entries,
  };
}

export function loadMapping(): MidiMapping {
  try {
    const text = require("fs").readFileSync(MAPPING_PATH, "utf-8");
    const data = JSON.parse(text);
    if (data?.entries?.length > 0) return data;
  } catch {
    // No saved mapping
  }
  return getDefaultK2Mapping();
}

export function saveMapping(m: MidiMapping): void {
  try {
    const dir = join(homedir(), ".jensdj");
    try { require("fs").mkdirSync(dir, { recursive: true }); } catch {}
    Bun.write(MAPPING_PATH, JSON.stringify(m, null, 2));
  } catch (e) {
    console.warn("[MIDI] Failed to save mapping:", e);
  }
}
