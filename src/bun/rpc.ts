import { BrowserView } from "electrobun/bun";
import type { MainViewRPC } from "../shared/types.ts";
import { AudioEngine } from "./audio/engine.ts";
import { initDB } from "./library/db.ts";
import { createRpcRequestHandlers } from "./rpcCore.ts";

const engine = new AudioEngine();

export function initEngine() {
  engine.init();
  initDB();
}

export function shutdownEngine() {
  engine.shutdown();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let webviewRef: any = null;

export function createRPC() {
  return BrowserView.defineRPC<MainViewRPC>({
    maxRequestTime: 120000,
    handlers: {
      requests: createRpcRequestHandlers(engine, {
        sendPlaybackTick: (payload) => webviewRef?.rpc?.send?.playbackTick?.(payload),
        sendScanProgress: (payload) => webviewRef?.rpc?.send?.scanProgress?.(payload),
      }),
      messages: {
        "*": (messageName, payload) => {
          console.log("[RPC message]", messageName, payload);
        },
        logToBun: ({ msg }) => {
          console.log("[WebView]", msg);
        },
      },
    },
  });
}

// Playback position ticker — sends position updates to webview
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function startPlaybackTicker(webview: any, intervalMs = 16) {
  webviewRef = webview;
  let logCounter = 0;
  const lastSnapshots = new Map<string, { position: number; isPlaying: boolean }>();
  return setInterval(() => {
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
      webview.rpc?.send?.playbackTick?.({
        trackId,
        position: pos,
        isPlaying,
        level: isPlaying ? engine.getLevel(trackId) : 0,
        ...(loop ? { loopStart: loop.start, loopEnd: loop.end } : {}),
      });
    }
    if (Object.keys(positions).length >= 2 && ++logCounter % 60 === 0) {
      const ids = Object.keys(positions);
      const posStrs = ids.map((id) => `${id}=${positions[id]!.toFixed(4)}s`).join(" ");
      const diff = Math.abs(positions[ids[0]!]! - positions[ids[1]!]!);
      console.log(`[SYNC] ${posStrs} diff=${(diff * 1000).toFixed(1)}ms`);
    }
  }, intervalMs);
}
