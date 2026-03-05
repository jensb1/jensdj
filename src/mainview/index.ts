import { Electroview } from "electrobun/view";
import type { MainViewRPC } from "../shared/types.ts";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { MainLayout } from "./components/layout/MainLayout.tsx";

console.log("[View] Initializing...");

// Define RPC handlers for messages FROM Bun
const rpc = Electroview.defineRPC<MainViewRPC>({
  maxRequestTime: 120000,
  handlers: {
    requests: {},
    messages: {
      playbackTick: ({ trackId, position }) => {
        window.dispatchEvent(
          new CustomEvent("dj:playbackTick", {
            detail: { trackId, position },
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

console.log("[View] RPC initialized, djRpc available:", !!window.djRpc);

// Mount React
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(createElement(MainLayout));
  console.log("[View] React mounted");
} else {
  console.error("[View] #root element not found");
}
