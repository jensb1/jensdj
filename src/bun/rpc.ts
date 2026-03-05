import { BrowserView, Utils } from "electrobun/bun";
import type { MainViewRPC } from "../shared/types.ts";
import { AudioEngine } from "./audio/engine.ts";
import { parseFile } from "music-metadata";
import { homedir } from "os";
import { join } from "path";
import { initDB, searchTracks, getTrackCount } from "./library/db.ts";
import { scanDirectory as scanDir } from "./library/scanner.ts";

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
      requests: {
        loadTrack: async ({ filePath }) => {
          console.log("[RPC] loadTrack:", filePath);

          // Skip macOS resource fork files
          const fileName = filePath.split("/").pop() ?? "";
          if (fileName.startsWith("._")) {
            throw new Error(`Skipping resource fork file: ${fileName}`);
          }

          let metadata = {
            title: fileName,
            artist: "Unknown",
            album: "",
            genre: "",
            duration: 0,
            bpm: 0,
            key: "",
            filePath,
          };

          try {
            const mm = await parseFile(filePath);
            metadata = {
              title: mm.common.title ?? metadata.title,
              artist: mm.common.artist ?? "Unknown",
              album: mm.common.album ?? "",
              genre: mm.common.genre?.[0] ?? "",
              duration: mm.format.duration ?? 0,
              bpm: mm.common.bpm ?? 0,
              key: "",
              filePath,
            };
            console.log("[RPC] Metadata:", metadata.title, "-", metadata.artist);
          } catch (e) {
            console.warn("[RPC] Metadata extraction failed:", e);
          }

          try {
            const track = engine.loadTrack(filePath, metadata);
            console.log("[RPC] Track loaded:", track.id, "duration:", track.duration);
            return track;
          } catch (e) {
            console.error("[RPC] loadTrack failed:", e);
            throw e;
          }
        },

        unloadTrack: ({ trackId }) => {
          engine.unloadTrack(trackId);
        },

        play: ({ trackId, fromTime }) => {
          engine.play(trackId, fromTime);
        },

        pause: ({ trackId }) => {
          engine.pause(trackId);
        },

        stop: ({ trackId }) => {
          engine.stop(trackId);
        },

        seek: ({ trackId, seconds }) => {
          engine.seek(trackId, seconds);
        },

        setVolume: ({ trackId, volume }) => {
          engine.setVolume(trackId, volume);
        },

        setEQ: ({ trackId, eq }) => {
          engine.setEQ(trackId, eq);
        },

        setOutputDevice: ({ trackId, deviceId }) => {
          engine.setOutputDevice(trackId, deviceId);
        },

        getOutputDevices: () => {
          return engine.getDevices();
        },

        scheduleSyncPlay: ({ targetTrackId, targetBeatSeconds, sourceTrackId, sourceBeatSeconds }) => {
          return engine.scheduleSyncPlay(targetTrackId, targetBeatSeconds, sourceTrackId, sourceBeatSeconds);
        },

        cancelScheduledStart: ({ trackId }) => {
          engine.cancelScheduledStart(trackId);
        },

        getPlaybackState: ({ trackId }) => {
          return {
            position: engine.getPosition(trackId),
            isPlaying: engine.isPlaying(trackId),
          };
        },

        openFileDialog: async () => {
          console.log("[RPC] openFileDialog called — calling Utils...");
          try {
            const paths = await Utils.openFileDialog({
              startingFolder: join(homedir(), "Music"),
              allowedFileTypes: "*",
              canChooseFiles: true,
              canChooseDirectory: false,
              allowsMultipleSelection: true,
            });
            console.log("[RPC] openFileDialog result:", paths);
            const audioExts = [".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".aiff"];
            const filtered = (paths ?? []).filter((p) => {
              const ext = p.toLowerCase().slice(p.lastIndexOf("."));
              return audioExts.includes(ext);
            });
            return filtered;
          } catch (e) {
            console.error("[RPC] openFileDialog error:", e);
            return [];
          }
        },

        openDirectoryDialog: async () => {
          const paths = await Utils.openFileDialog({
            startingFolder: join(homedir(), "Music"),
            allowedFileTypes: "*",
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          });
          return paths?.[0] ?? "";
        },

        scanDirectory: async ({ dirPath }) => {
          console.log("[RPC] scanDirectory:", dirPath);
          await scanDir(dirPath, {
            onProgress: (current, total, file) => {
              webviewRef?.rpc?.send?.scanProgress?.({ current, total, file });
            },
            onComplete: (added) => {
              console.log("[RPC] Scan complete:", added, "files. Total library:", getTrackCount());
            },
          });
        },

        searchLibrary: ({ query, sortBy, sortDir }) => {
          const dir = sortDir === "desc" ? "desc" : "asc";
          return searchTracks(query ?? "", sortBy ?? "title", dir).map((t) => ({
            title: t.title,
            artist: t.artist,
            album: t.album,
            genre: t.genre,
            duration: t.duration,
            bpm: t.bpm,
            key: t.key,
            filePath: t.filePath,
          }));
        },
      },
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
  return setInterval(() => {
    for (const trackId of engine.getAllTrackIds()) {
      if (engine.isPlaying(trackId)) {
        webview.rpc?.send?.playbackTick?.({
          trackId,
          position: engine.getPosition(trackId),
          level: engine.getLevel(trackId),
        });
      }
    }
  }, intervalMs);
}
