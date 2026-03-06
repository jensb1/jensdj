import { parseFile } from "music-metadata";
import { homedir } from "os";
import { join } from "path";
import { AudioEngine } from "./audio/engine.ts";
import { initDB, searchTracks, getTrackCount } from "./library/db.ts";
import { scanDirectory as scanDir } from "./library/scanner.ts";

interface PlaybackTickPayload {
  trackId: string;
  position: number;
  isPlaying: boolean;
  level: number;
  loopStart?: number;
  loopEnd?: number;
}

interface ScanProgressPayload {
  current: number;
  total: number;
  file: string;
}

interface RequestHandlerHooks {
  sendPlaybackTick?: (payload: PlaybackTickPayload) => void;
  sendScanProgress?: (payload: ScanProgressPayload) => void;
}

export function createRpcRequestHandlers(audioEngine: AudioEngine, hooks: RequestHandlerHooks = {}) {
  const { sendPlaybackTick, sendScanProgress } = hooks;

  return {
    loadTrack: async ({ filePath }: { filePath: string }) => {
      console.log("[RPC] loadTrack:", filePath);

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
        const track = audioEngine.loadTrack(filePath, metadata);
        console.log("[RPC] Track loaded:", track.id, "duration:", track.duration);
        return track;
      } catch (e) {
        console.error("[RPC] loadTrack failed:", e);
        throw e;
      }
    },

    unloadTrack: ({ trackId }: { trackId: string }) => {
      audioEngine.unloadTrack(trackId);
    },

    play: ({ trackId, fromTime }: { trackId: string; fromTime?: number }) => {
      audioEngine.play(trackId, fromTime);
    },

    pause: ({ trackId }: { trackId: string }) => {
      audioEngine.pause(trackId);
      sendPlaybackTick?.({
        trackId,
        position: audioEngine.getPosition(trackId),
        isPlaying: audioEngine.isPlaying(trackId),
        level: 0,
      });
    },

    stop: ({ trackId }: { trackId: string }) => {
      audioEngine.stop(trackId);
      sendPlaybackTick?.({
        trackId,
        position: audioEngine.getPosition(trackId),
        isPlaying: audioEngine.isPlaying(trackId),
        level: 0,
      });
    },

    seek: ({ trackId, seconds }: { trackId: string; seconds: number }) => {
      audioEngine.seek(trackId, seconds);
      sendPlaybackTick?.({
        trackId,
        position: audioEngine.getPosition(trackId),
        isPlaying: audioEngine.isPlaying(trackId),
        level: 0,
      });
    },

    setVolume: ({ trackId, volume }: { trackId: string; volume: number }) => {
      audioEngine.setVolume(trackId, volume);
    },

    setEQ: ({ trackId, eq }: { trackId: string; eq: { lo: number; mid: number; hi: number } }) => {
      audioEngine.setEQ(trackId, eq);
    },

    setOutputDevice: ({ trackId, deviceId }: { trackId: string; deviceId: number }) => {
      audioEngine.setOutputDevice(trackId, deviceId);
    },

    getOutputDevices: () => {
      return audioEngine.getDevices();
    },

    scheduleSyncPlay: ({
      targetTrackId,
      targetBeatSeconds,
      sourceTrackId,
      sourceBeatSeconds,
    }: {
      targetTrackId: string;
      targetBeatSeconds: number;
      sourceTrackId: string;
      sourceBeatSeconds: number;
    }) => {
      return audioEngine.scheduleSyncPlay(targetTrackId, targetBeatSeconds, sourceTrackId, sourceBeatSeconds);
    },

    syncStart: ({
      targetTrackId,
      targetBeat,
      sourceTrackId,
      sourceBeat,
      barDuration,
      preserveTransport,
    }: {
      targetTrackId: string;
      targetBeat: number;
      sourceTrackId: string;
      sourceBeat: number;
      barDuration: number;
      preserveTransport?: boolean;
    }) => {
      return audioEngine.syncStart(targetTrackId, targetBeat, sourceTrackId, sourceBeat, barDuration, preserveTransport);
    },

    cancelScheduledStart: ({ trackId }: { trackId: string }) => {
      audioEngine.cancelScheduledStart(trackId);
    },

    setLoop: ({ trackId, startSec, endSec }: { trackId: string; startSec: number; endSec: number }) => {
      audioEngine.setLoop(trackId, startSec, endSec);
    },

    clearLoop: ({ trackId }: { trackId: string }) => {
      audioEngine.clearLoop(trackId);
    },

    setMasterBpm: ({ bpm }: { bpm: number }) => {
      audioEngine.setMasterBpm(bpm);
    },

    getPlaybackState: ({ trackId }: { trackId: string }) => {
      return {
        position: audioEngine.getPosition(trackId),
        isPlaying: audioEngine.isPlaying(trackId),
      };
    },

    openFileDialog: async () => {
      console.log("[RPC] openFileDialog called — calling Utils...");
      try {
        const { Utils } = await import("electrobun/bun");
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
      const { Utils } = await import("electrobun/bun");
      const paths = await Utils.openFileDialog({
        startingFolder: join(homedir(), "Music"),
        allowedFileTypes: "*",
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      return paths?.[0] ?? "";
    },

    scanDirectory: async ({ dirPath }: { dirPath: string }) => {
      console.log("[RPC] scanDirectory:", dirPath);
      await scanDir(dirPath, {
        onProgress: (current, total, file) => {
          sendScanProgress?.({ current, total, file });
        },
        onComplete: (added) => {
          console.log("[RPC] Scan complete:", added, "files. Total library:", getTrackCount());
        },
      });
    },

    searchLibrary: ({ query, sortBy, sortDir }: { query: string; sortBy?: string; sortDir?: string }) => {
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
  };
}

export function createCliRpcClient(audioEngine = new AudioEngine()) {
  return {
    engine: audioEngine,
    init: () => {
      audioEngine.init();
      initDB();
    },
    shutdown: () => {
      audioEngine.shutdown();
    },
    request: createRpcRequestHandlers(audioEngine),
  };
}
