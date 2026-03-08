import { parseFile } from "music-metadata";
import { homedir } from "os";
import { join } from "path";
import { AudioEngine } from "./audio/engine.ts";
import {
  initDB, searchTracks, getTrackCount,
  getCuesForTrack, upsertCue, deleteCue as dbDeleteCue,
  upsertAutomation, deleteAutomation as dbDeleteAutomation,
  upsertCollectionTrack, getCollectionTrack, getAllCollectionTracks,
} from "./library/db.ts";
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

    setFilter: ({ trackId, value }: { trackId: string; value: number }) => {
      audioEngine.setFilter(trackId, value);
    },

    getPlaybackState: ({ trackId }: { trackId: string }) => {
      return {
        position: audioEngine.getPosition(trackId),
        isPlaying: audioEngine.isPlaying(trackId),
      };
    },

    getSyncDiff: ({ trackId1, trackId2, beatRef, barDuration }: {
      trackId1: string; trackId2: string; beatRef: number; barDuration: number;
    }) => {
      return audioEngine.getSyncDiff(trackId1, trackId2, beatRef, barDuration);
    },

    getPlaybackStates: ({ trackIds }: { trackIds: string[] }) => {
      const result: Record<string, { position: number; isPlaying: boolean }> = {};
      for (const id of trackIds) {
        result[id] = {
          position: audioEngine.getPosition(id),
          isPlaying: audioEngine.isPlaying(id),
        };
      }
      return result;
    },

    getTempoInfo: ({ trackIds }: { trackIds: string[] }) => {
      const result: Record<string, { originalBpm: number; tempoRatio: number; masterBpm: number }> = {};
      for (const id of trackIds) {
        result[id] = {
          originalBpm: audioEngine.getOriginalBpm(id),
          tempoRatio: audioEngine.getTempoRatio(id),
          masterBpm: audioEngine.masterBpm,
        };
      }
      return result;
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

    getCuesForTrack: ({ filePath }: { filePath: string }) => {
      return getCuesForTrack(filePath);
    },

    saveCue: ({ cue }: { cue: { id: string; filePath: string; label: string; time: number; color: string; active: boolean } }) => {
      upsertCue(cue);
    },

    deleteCue: ({ cueId }: { cueId: string }) => {
      dbDeleteCue(cueId);
    },

    saveCueAutomation: ({ id, cueId, type, durationBars, interpolation, startValue, endValue, targetCueId, targetFilePath }: {
      id: string; cueId: string; type: string; durationBars: number; interpolation: string;
      startValue: number; endValue: number; targetCueId?: string; targetFilePath?: string;
    }) => {
      upsertAutomation({ id, cueId, type, durationBars, interpolation, startValue, endValue, targetCueId, targetFilePath });
    },

    deleteCueAutomation: ({ automationId }: { automationId: string }) => {
      dbDeleteAutomation(automationId);
    },

    setAutomation: ({ trackId, param, startVal, endVal, durationSeconds, interp }: {
      trackId: string; param: number; startVal: number; endVal: number; durationSeconds: number; interp: number;
    }) => {
      audioEngine.setAutomation(trackId, param, startVal, endVal, durationSeconds, interp);
    },

    cancelAutomation: ({ trackId, param }: { trackId: string; param: number }) => {
      audioEngine.cancelAutomation(trackId, param);
    },

    isAutomationActive: ({ trackId, param }: { trackId: string; param: number }) => {
      return audioEngine.isAutomationActive(trackId, param);
    },

    getAutomationValue: ({ trackId, param }: { trackId: string; param: number }) => {
      return audioEngine.getAutomationValue(trackId, param);
    },

    saveCollectionTrack: ({ filePath, title, artist, album, genre, duration, bpm, key, peaks, beats }: {
      filePath: string; title: string; artist: string; album: string; genre: string;
      duration: number; bpm: number; key: string; peaks: unknown; beats: unknown;
    }) => {
      upsertCollectionTrack({
        filePath, title, artist, album, genre, duration, bpm, key,
        peaks: peaks as import("../shared/types.ts").Peaks3Band | null,
        beats: beats as number[] | null,
      });
    },

    getCollectionTrack: ({ filePath }: { filePath: string }) => {
      return getCollectionTrack(filePath);
    },

    getCollectionTracks: () => {
      return getAllCollectionTracks();
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
