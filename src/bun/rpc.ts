import { BrowserView } from "electrobun/bun";
import type { MainViewRPC } from "../shared/types.ts";
import { AudioEngine } from "./audio/engine.ts";
import { initDB } from "./library/db.ts";
import { handleAutomationResult } from "./automation.ts";
import { createRpcRequestHandlers } from "./rpcCore.ts";
import { MidiController } from "./midi/controller.ts";

const engine = new AudioEngine();
let midiController: MidiController | null = null;

export function initEngine() {
  engine.init();
  initDB();
}

export function shutdownEngine() {
  midiController?.shutdown();
  engine.shutdown();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let webviewRef: any = null;

export function createRPC() {
  const coreHandlers = createRpcRequestHandlers(engine, {
    sendPlaybackTick: (payload) => webviewRef?.rpc?.send?.playbackTick?.(payload),
    sendScanProgress: (payload) => webviewRef?.rpc?.send?.scanProgress?.(payload),
  });

  return BrowserView.defineRPC<MainViewRPC>({
    maxRequestTime: 120000,
    handlers: {
      requests: {
        ...coreHandlers,
        getMidiDevices: () => {
          return midiController?.getDevices() ?? { sources: [], destinations: [] };
        },
        openMidiInput: ({ sourceIndex }: { sourceIndex: number }) => {
          return midiController?.openInput(sourceIndex) ?? false;
        },
      },
      messages: {
        logToBun: ({ msg }) => {
          console.log("[WebView]", msg);
        },
        automationResult: (payload) => {
          handleAutomationResult(payload);
        },
      },
    },
  });
}

// Playback position ticker — sends position updates to webview
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function startPlaybackTicker(webview: any, intervalMs = 16) {
  webviewRef = webview;

  // Initialize MIDI controller
  const sendToWebview = (msg: string, payload: Record<string, unknown>) => {
    const send = webview?.rpc?.send;
    if (send && typeof send[msg] === "function") {
      send[msg](payload);
    }
  };
  midiController = new MidiController(engine, sendToWebview);
  midiController.init();

  let logCounter = 0;
  const lastSnapshots = new Map<string, { position: number; isPlaying: boolean }>();
  return setInterval(() => {
    // Poll MIDI messages
    midiController?.poll();
    const positions: Record<string, number> = {};
    for (const trackId of engine.getAllTrackIds()) {
      const pos = engine.getPosition(trackId);
      const isPlaying = engine.isPlaying(trackId);
      const last = lastSnapshots.get(trackId);
      const positionChanged = !last || Math.abs(last.position - pos) > 0.0005;
      const playingChanged = !last || last.isPlaying !== isPlaying;
      lastSnapshots.set(trackId, { position: pos, isPlaying });

      if (!isPlaying && !positionChanged && !playingChanged) continue;

      if (isPlaying) {
        positions[trackId] = pos;
      }

      const loop = engine.getActiveLoop(trackId);
      const filterAutoActive = engine.isAutomationActive(trackId, 0); // DJ_PARAM_FILTER
      const volumeAutoActive = engine.isAutomationActive(trackId, 1); // DJ_PARAM_VOLUME
      const eqLoAuto = engine.isAutomationActive(trackId, 2);
      const eqMidAuto = engine.isAutomationActive(trackId, 3);
      const eqHiAuto = engine.isAutomationActive(trackId, 4);
      const eqAutoActive = eqLoAuto || eqMidAuto || eqHiAuto;
      webview.rpc?.send?.playbackTick?.({
        trackId,
        position: pos,
        isPlaying,
        level: isPlaying ? engine.getLevel(trackId) : 0,
        ...(loop ? { loopStart: loop.start, loopEnd: loop.end } : {}),
        ...(filterAutoActive ? { filterValue: engine.getFilter(trackId), filterAutomationActive: true } : {}),
        ...(volumeAutoActive ? { volumeAutomationActive: true } : {}),
        ...(eqAutoActive ? (() => { const eq = engine.getEQ(trackId); return { eqLo: eq.lo, eqMid: eq.mid, eqHi: eq.hi, eqAutomationActive: true }; })() : {}),
      });
    }
    if (Object.keys(positions).length >= 1 && ++logCounter % 60 === 0) {
      const ids = Object.keys(positions);
      const parts = ids.map((id) => {
        const diff = engine.getTrackSyncDiff(id);
        return `${id}=${positions[id]!.toFixed(4)}s(${(Math.abs(diff) * 1000).toFixed(1)}ms)`;
      });
      console.log(`[SYNC] ${parts.join(" ")}`);
    }
  }, intervalMs);
}
