import { BrowserWindow } from "electrobun/bun";
import { registerAutomationWebview, startAutomationServer } from "./automation.ts";
import { createRPC, initEngine, startPlaybackTicker } from "./rpc.ts";

// Initialize native audio engine
initEngine();

// Create RPC with handlers
const mainViewRPC = createRPC();

// Create main window
const win = new BrowserWindow({
  title: "JensDJ",
  url: "views://mainview/index.html",
  frame: {
    width: 1400,
    height: 900,
    x: 100,
    y: 100,
  },
  titleBarStyle: "default",
  rpc: mainViewRPC,
});

registerAutomationWebview(win.webview);
startAutomationServer();

// Start playback position ticker (60fps → webview)
startPlaybackTicker(win.webview);

console.log("[JensDJ] Application started");
