import { Electroview } from "electrobun/view";
import type { MainViewRPC } from "../shared/types.ts";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { MainLayout } from "./components/layout/MainLayout.tsx";
import { debugLogThrottled, logError, logInfo, logWarn } from "./lib/debugLog.ts";
import { usePlayerStore } from "./stores/playerStore.ts";

logInfo("view.init");

// Define RPC handlers for messages FROM Bun
const rpc = Electroview.defineRPC<MainViewRPC>({
  maxRequestTime: 120000,
  handlers: {
    requests: {},
    messages: {
      playbackTick: ({ trackId, position, isPlaying, level, loopStart, loopEnd }) => {
        const trackState = usePlayerStore.getState().tracks.get(trackId);
        if (trackState && trackState.isPlaying !== isPlaying) {
          logInfo("playback.stateSync", {
            trackId,
            from: trackState.isPlaying,
            to: isPlaying,
            position: Number(position.toFixed(3)),
          });
          usePlayerStore.getState().setPlaying(trackId, isPlaying);
        }
        debugLogThrottled(`playbackTick:${trackId}`, 1000, "index.playbackTick", {
          trackId,
          position: Number(position.toFixed(3)),
          isPlaying,
          level: Number(level.toFixed(3)),
          loopStart: loopStart != null ? Number(loopStart.toFixed(3)) : null,
          loopEnd: loopEnd != null ? Number(loopEnd.toFixed(3)) : null,
        });
        window.dispatchEvent(
          new CustomEvent("dj:playbackTick", {
            detail: { trackId, position, isPlaying, level, loopStart, loopEnd },
          })
        );
      },
      scanProgress: ({ current, total, file }) => {
        window.dispatchEvent(
          new CustomEvent("dj:scanProgress", {
            detail: { current, total, file },
          })
        );
      },
      trackAnalyzed: ({ trackId, bpm, beats, peaks }) => {
        window.dispatchEvent(
          new CustomEvent("dj:trackAnalyzed", {
            detail: { trackId, bpm, beats, peaks },
          })
        );
      },
    },
  },
});

const electroview = new Electroview({ rpc });

// Expose RPC globally so React components can call Bun functions
declare global {
  interface Window {
    djRpc: typeof electroview.rpc;
  }
}
window.djRpc = electroview.rpc;

logInfo("rpc.ready", { hasRpc: !!window.djRpc });

window.addEventListener("error", (event) => {
  logError("window.error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  logWarn("window.unhandledrejection", {
    reason: String(event.reason),
  });
});

// Mount React
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(createElement(MainLayout));
  logInfo("view.mounted");
} else {
  logError("view.rootMissing");
}
