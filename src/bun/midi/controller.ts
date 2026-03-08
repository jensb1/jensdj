import {
  midiInit,
  midiShutdown,
  midiGetSourceCount,
  midiGetSourceName,
  midiOpenInput,
  midiCloseInput,
  midiPoll,
  midiGetDestCount,
  midiGetDestName,
  midiOpenOutput,
  midiSend,
  type MidiMessage,
} from "./ffi.ts";
import { loadMapping, type MidiMapping, type MidiMapEntry } from "./mapping.ts";
import type { AudioEngine } from "../audio/engine.ts";

// Webview RPC send function type
type SendFn = (msg: string, payload: Record<string, unknown>) => void;

export class MidiController {
  private engine: AudioEngine;
  private sendToWebview: SendFn;
  private mapping: MidiMapping;
  private selectedTrackIndex = 0;
  private connected = false;
  private deviceName: string | null = null;
  private entryLookup = new Map<string, MidiMapEntry>();
  private trackEqState = new Map<string, { lo: number; mid: number; hi: number }>();

  constructor(engine: AudioEngine, sendToWebview: SendFn) {
    this.engine = engine;
    this.sendToWebview = sendToWebview;
    this.mapping = loadMapping();
    this.buildLookup();
  }

  private buildLookup() {
    this.entryLookup.clear();
    for (const entry of this.mapping.entries) {
      const key = `${entry.channel}:${entry.type}:${entry.number}`;
      this.entryLookup.set(key, entry);
    }
  }

  init(): boolean {
    const result = midiInit();
    if (result !== 0) {
      console.error("[MIDI] Init failed:", result);
      return false;
    }

    // Auto-detect Xone K2
    const sourceCount = midiGetSourceCount();
    let autoIndex = -1;
    for (let i = 0; i < sourceCount; i++) {
      const name = midiGetSourceName(i);
      if (name.toUpperCase().includes("XONE") || name.toUpperCase().includes("K2")) {
        autoIndex = i;
        this.deviceName = name;
        break;
      }
    }

    if (autoIndex >= 0) {
      const openResult = midiOpenInput(autoIndex);
      if (openResult === 0) {
        this.connected = true;
        console.log(`[MIDI] Auto-connected input: ${this.deviceName}`);

        // Try to open matching output for LED feedback
        const destCount = midiGetDestCount();
        for (let i = 0; i < destCount; i++) {
          const name = midiGetDestName(i);
          if (name.toUpperCase().includes("XONE") || name.toUpperCase().includes("K2")) {
            midiOpenOutput(i);
            console.log(`[MIDI] Auto-connected output: ${name}`);
            break;
          }
        }
      }
    } else if (sourceCount > 0) {
      // No K2 found — open first available source
      const name = midiGetSourceName(0);
      if (midiOpenInput(0) === 0) {
        this.connected = true;
        this.deviceName = name;
        console.log(`[MIDI] Connected to first available: ${name}`);
      }
    } else {
      console.log("[MIDI] No MIDI sources found");
    }

    this.sendMidiState();
    return true;
  }

  poll(): void {
    if (!this.connected) return;
    const messages = midiPoll();
    for (const msg of messages) {
      this.handleMessage(msg);
    }
  }

  shutdown(): void {
    midiCloseInput();
    midiShutdown();
    this.connected = false;
  }

  getDevices(): { sources: string[]; destinations: string[] } {
    const sources: string[] = [];
    const destinations: string[] = [];
    const srcCount = midiGetSourceCount();
    for (let i = 0; i < srcCount; i++) sources.push(midiGetSourceName(i));
    const dstCount = midiGetDestCount();
    for (let i = 0; i < dstCount; i++) destinations.push(midiGetDestName(i));
    return { sources, destinations };
  }

  openInput(sourceIndex: number): boolean {
    midiCloseInput();
    const result = midiOpenInput(sourceIndex);
    if (result === 0) {
      this.connected = true;
      this.deviceName = midiGetSourceName(sourceIndex);
      this.sendMidiState();
      return true;
    }
    return false;
  }

  private handleMessage(msg: MidiMessage) {
    const { status, data1, data2, channel } = msg;

    if (status === 0xB0) {
      // CC message
      const key = `${channel}:cc:${data1}`;
      const entry = this.entryLookup.get(key);
      if (entry) {
        console.log(`[MIDI] CC ${data1} val=${data2} → ${entry.action}${entry.trackIndex !== undefined ? `.${entry.trackIndex}` : ""}`);
        this.dispatch(entry, data2);
      } else {
        console.log(`[MIDI] CC ch=${channel} cc=${data1} val=${data2} (unmapped)`);
      }
    } else if (status === 0x90 && data2 > 0) {
      // Note on
      console.log(`[MIDI] NoteOn ch=${channel} note=${data1} vel=${data2}`);
      const key = `${channel}:note:${data1}`;
      const entry = this.entryLookup.get(key);
      if (entry) {
        this.dispatch(entry, data2);
      }
    } else {
      console.log(`[MIDI] status=0x${status.toString(16)} ch=${channel} d1=${data1} d2=${data2}`);
    }
    // Note off (0x80 or 0x90 with vel=0) — currently not needed
  }

  private dispatch(entry: MidiMapEntry, value: number) {
    const trackIds = this.engine.getAllTrackIds();
    const resolveTrackId = (idx?: number): string | null => {
      if (idx !== undefined) {
        return trackIds[idx] ?? null;
      }
      return trackIds[this.selectedTrackIndex] ?? null;
    };

    switch (entry.action) {
      case "volume": {
        const trackId = resolveTrackId(entry.trackIndex);
        if (!trackId) return;
        const vol = value / 127;
        this.engine.setVolume(trackId, vol);
        this.sendToWebview("midiAction", {
          action: "volume",
          trackId,
          value: vol,
        });
        break;
      }

      case "eqHi":
      case "eqMid":
      case "eqLo": {
        const trackId = resolveTrackId(entry.trackIndex);
        if (!trackId) return;
        // Map 0-127 → 0-2 (64 = unity)
        const eqVal = (value / 127) * 2;
        const band = entry.action === "eqHi" ? "hi" : entry.action === "eqMid" ? "mid" : "lo";
        // Get current EQ, update one band
        this.sendToWebview("midiAction", {
          action: "eq",
          trackId,
          value: eqVal,
          band,
        });
        const eqState = this.trackEqState.get(trackId) ?? { lo: 1, mid: 1, hi: 1 };
        eqState[band] = eqVal;
        this.trackEqState.set(trackId, eqState);
        this.engine.setEQ(trackId, eqState);
        break;
      }

      case "selectTrack": {
        if (entry.trackIndex !== undefined) {
          // Direct track selection by index
          if (entry.trackIndex < trackIds.length) {
            this.selectedTrackIndex = entry.trackIndex;
            this.sendMidiState();
          }
        } else {
          // Relative cycling (fallback)
          const delta = this.decodeRelative(value);
          if (trackIds.length === 0) return;
          this.selectedTrackIndex =
            ((this.selectedTrackIndex + delta) % trackIds.length + trackIds.length) % trackIds.length;
          this.sendMidiState();
        }
        break;
      }

      case "selectCue": {
        const delta = this.decodeRelative(value);
        this.sendToWebview("midiAction", {
          action: "selectCue",
          trackId: resolveTrackId(),
          value: delta,
        });
        break;
      }

      case "activateCue": {
        this.sendToWebview("midiAction", {
          action: "activateCue",
          trackId: resolveTrackId(),
          value: 1,
        });
        break;
      }

      case "jumpPreview": {
        const delta = this.decodeRelative(value);
        this.sendToWebview("midiAction", {
          action: "jumpPreview",
          trackId: resolveTrackId(),
          value: delta,
        });
        break;
      }

      case "returnToPlay": {
        this.sendToWebview("midiAction", {
          action: "returnToPlay",
          trackId: resolveTrackId(),
          value: 1,
        });
        break;
      }

      case "play": {
        const trackId = resolveTrackId(entry.trackIndex);
        if (!trackId) return;
        if (this.engine.isPlaying(trackId)) {
          this.engine.pause(trackId);
        } else {
          // Send to frontend for syncPlay logic
          this.sendToWebview("midiAction", {
            action: "play",
            trackId,
            value: 1,
          });
        }
        break;
      }

      case "cue": {
        const trackId = resolveTrackId(entry.trackIndex);
        if (!trackId) return;
        this.sendToWebview("midiAction", {
          action: "cue",
          trackId,
          value: this.engine.getPosition(trackId),
        });
        break;
      }

      case "addCue": {
        const trackId = resolveTrackId();
        if (!trackId) return;
        this.sendToWebview("midiAction", {
          action: "addCue",
          trackId,
          value: this.engine.getPosition(trackId),
        });
        break;
      }

      case "loop": {
        const trackId = resolveTrackId(entry.trackIndex);
        if (!trackId) return;
        if (this.engine.isLooping(trackId)) {
          this.engine.clearLoop(trackId);
        } else {
          // Send to frontend to trigger 4-bar loop
          this.sendToWebview("midiAction", {
            action: "loop",
            trackId,
            value: 1,
          });
        }
        break;
      }
    }
  }

  private decodeRelative(value: number): number {
    // Two's complement encoding: 1=CW (+1), 127=CCW (-1)
    if (value >= 64) return -(128 - value);
    return value;
  }

  private sendMidiState() {
    const trackIds = this.engine.getAllTrackIds();
    this.sendToWebview("midiState", {
      selectedTrackId: trackIds[this.selectedTrackIndex] ?? null,
      selectedCueIndex: 0,
      connected: this.connected,
      deviceName: this.deviceName,
    });
  }

  // Send LED feedback to controller
  sendLed(note: number, value: number) {
    if (this.connected) {
      midiSend(0x90 | this.mapping.channel, note, value);
    }
  }
}
