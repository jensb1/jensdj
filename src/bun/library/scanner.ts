import { readdir } from "fs/promises";
import { join, extname } from "path";
import { parseFile } from "music-metadata";
import { upsertTracks, type LibraryTrack } from "./db.ts";

const AUDIO_EXTS = new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".aiff", ".aif", ".opus", ".wma"]);

interface ScanCallbacks {
  onProgress: (current: number, total: number, file: string) => void;
  onComplete: (added: number) => void;
}

export async function scanDirectory(dirPath: string, callbacks: ScanCallbacks): Promise<void> {
  console.log("[Scanner] Starting scan:", dirPath);

  // Phase 1: Collect all audio file paths
  const files: string[] = [];
  await collectAudioFiles(dirPath, files);
  console.log("[Scanner] Found", files.length, "audio files");

  if (files.length === 0) {
    callbacks.onComplete(0);
    return;
  }

  // Phase 2: Extract metadata and insert in batches
  const BATCH_SIZE = 50;
  let processed = 0;
  let batch: Omit<LibraryTrack, "id" | "addedAt" | "lastPlayedAt">[] = [];

  for (const filePath of files) {
    try {
      const meta = await extractMetadata(filePath);
      batch.push(meta);
    } catch (e) {
      // Skip files that fail metadata extraction
      console.warn("[Scanner] Failed:", filePath, e);
    }

    processed++;
    if (processed % 10 === 0 || processed === files.length) {
      callbacks.onProgress(processed, files.length, filePath);
    }

    if (batch.length >= BATCH_SIZE) {
      upsertTracks(batch);
      batch = [];
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    upsertTracks(batch);
  }

  console.log("[Scanner] Complete:", processed, "files processed");
  callbacks.onComplete(processed);
}

async function collectAudioFiles(dirPath: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return; // Permission denied or similar
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectAudioFiles(fullPath, out);
    } else if (entry.isFile()) {
      if (entry.name.startsWith("._")) continue; // macOS resource fork
      const ext = extname(entry.name).toLowerCase();
      if (AUDIO_EXTS.has(ext)) {
        out.push(fullPath);
      }
    }
  }
}

async function extractMetadata(
  filePath: string
): Promise<Omit<LibraryTrack, "id" | "addedAt" | "lastPlayedAt">> {
  const fileName = filePath.split("/").pop() ?? "Unknown";

  let title = fileName.replace(/\.[^.]+$/, "");
  let artist = "";
  let album = "";
  let genre = "";
  let duration = 0;
  let bpm = 0;
  let sampleRate = 0;
  let bitrate = 0;

  try {
    const mm = await parseFile(filePath);
    title = mm.common.title ?? title;
    artist = mm.common.artist ?? "";
    album = mm.common.album ?? "";
    genre = mm.common.genre?.[0] ?? "";
    duration = mm.format.duration ?? 0;
    bpm = mm.common.bpm ?? 0;
    sampleRate = mm.format.sampleRate ?? 0;
    bitrate = mm.format.bitrate ? Math.round(mm.format.bitrate / 1000) : 0;
  } catch {
    // Use filename-based defaults
  }

  return {
    filePath,
    title,
    artist,
    album,
    genre,
    duration,
    bpm,
    key: "",
    sampleRate,
    bitrate,
  };
}
