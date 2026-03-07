import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const DB_DIR = join(homedir(), ".jensdj");
const DB_PATH = join(DB_DIR, "library.db");

let db: Database;

export function initDB(): Database {
  if (db) return db;

  mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filePath TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      artist TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '',
      genre TEXT NOT NULL DEFAULT '',
      duration REAL NOT NULL DEFAULT 0,
      bpm REAL NOT NULL DEFAULT 0,
      key TEXT NOT NULL DEFAULT '',
      sampleRate INTEGER NOT NULL DEFAULT 0,
      bitrate INTEGER NOT NULL DEFAULT 0,
      addedAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastPlayedAt TEXT
    );
  `);

  // Full-text search virtual table
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
      title, artist, album, genre,
      content='tracks',
      content_rowid='id'
    );
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
      INSERT INTO tracks_fts(rowid, title, artist, album, genre)
      VALUES (new.id, new.title, new.artist, new.album, new.genre);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre)
      VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre)
      VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre);
      INSERT INTO tracks_fts(rowid, title, artist, album, genre)
      VALUES (new.id, new.title, new.artist, new.album, new.genre);
    END;
  `);

  // Collection: tracks the DJ has actively worked with
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_tracks (
      filePath TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      artist TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '',
      genre TEXT NOT NULL DEFAULT '',
      duration REAL NOT NULL DEFAULT 0,
      bpm REAL NOT NULL DEFAULT 0,
      key TEXT NOT NULL DEFAULT '',
      peaks BLOB,
      beats BLOB,
      addedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Cue points linked to collection tracks by filePath
  db.exec(`
    CREATE TABLE IF NOT EXISTS cue_points (
      id TEXT PRIMARY KEY,
      filePath TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      time REAL NOT NULL,
      color TEXT NOT NULL DEFAULT '#22c55e',
      active INTEGER NOT NULL DEFAULT 0,
      UNIQUE(filePath, time)
    );
  `);

  // Connections between cue points
  db.exec(`
    CREATE TABLE IF NOT EXISTS cue_connections (
      id TEXT PRIMARY KEY,
      sourceCueId TEXT NOT NULL REFERENCES cue_points(id) ON DELETE CASCADE,
      targetCueId TEXT NOT NULL REFERENCES cue_points(id) ON DELETE CASCADE,
      targetFilePath TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'start',
      UNIQUE(sourceCueId, targetCueId)
    );
  `);

  console.log("[DB] Library database initialized at", DB_PATH);
  return db;
}

export interface LibraryTrack {
  id: number;
  filePath: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  bpm: number;
  key: string;
  sampleRate: number;
  bitrate: number;
  addedAt: string;
  lastPlayedAt: string | null;
}

const insertStmt = () =>
  db.prepare(`
    INSERT OR IGNORE INTO tracks (filePath, title, artist, album, genre, duration, bpm, key, sampleRate, bitrate)
    VALUES ($filePath, $title, $artist, $album, $genre, $duration, $bpm, $key, $sampleRate, $bitrate)
  `);

export function upsertTrack(track: Omit<LibraryTrack, "id" | "addedAt" | "lastPlayedAt">): void {
  insertStmt().run({
    $filePath: track.filePath,
    $title: track.title,
    $artist: track.artist,
    $album: track.album,
    $genre: track.genre,
    $duration: track.duration,
    $bpm: track.bpm,
    $key: track.key,
    $sampleRate: track.sampleRate,
    $bitrate: track.bitrate,
  });
}

export function upsertTracks(tracks: Omit<LibraryTrack, "id" | "addedAt" | "lastPlayedAt">[]): void {
  const stmt = insertStmt();
  const transaction = db.transaction(() => {
    for (const track of tracks) {
      stmt.run({
        $filePath: track.filePath,
        $title: track.title,
        $artist: track.artist,
        $album: track.album,
        $genre: track.genre,
        $duration: track.duration,
        $bpm: track.bpm,
        $key: track.key,
        $sampleRate: track.sampleRate,
        $bitrate: track.bitrate,
      });
    }
  });
  transaction();
}

export function searchTracks(
  query: string,
  sortBy = "title",
  sortDir: "asc" | "desc" = "asc",
  limit = 500
): LibraryTrack[] {
  const validColumns = ["title", "artist", "album", "genre", "duration", "bpm", "addedAt"];
  const col = validColumns.includes(sortBy) ? sortBy : "title";
  const dir = sortDir === "desc" ? "DESC" : "ASC";

  if (!query.trim()) {
    return db
      .prepare(`SELECT * FROM tracks ORDER BY ${col} ${dir} LIMIT ?`)
      .all(limit) as LibraryTrack[];
  }

  // FTS search with ranking
  return db
    .prepare(
      `SELECT t.* FROM tracks t
       JOIN tracks_fts fts ON t.id = fts.rowid
       WHERE tracks_fts MATCH ?
       ORDER BY rank, t.${col} ${dir}
       LIMIT ?`
    )
    .all(query + "*", limit) as LibraryTrack[];
}

export function getAllTracks(sortBy = "title", sortDir: "asc" | "desc" = "asc"): LibraryTrack[] {
  return searchTracks("", sortBy, sortDir);
}

export function getTrackCount(): number {
  return (db.prepare("SELECT COUNT(*) as count FROM tracks").get() as { count: number }).count;
}

export function removeTrack(filePath: string): void {
  db.prepare("DELETE FROM tracks WHERE filePath = ?").run(filePath);
}

// --- Collection CRUD ---

import type { CuePoint, CueConnection, CollectionTrack, Peaks3Band } from "../../shared/types.ts";

export function upsertCollectionTrack(track: {
  filePath: string; title: string; artist: string; album: string; genre: string;
  duration: number; bpm: number; key: string; peaks: Peaks3Band | null; beats: number[] | null;
}): void {
  db.prepare(`
    INSERT INTO collection_tracks (filePath, title, artist, album, genre, duration, bpm, key, peaks, beats)
    VALUES ($filePath, $title, $artist, $album, $genre, $duration, $bpm, $key, $peaks, $beats)
    ON CONFLICT(filePath) DO UPDATE SET
      title=$title, artist=$artist, album=$album, genre=$genre,
      duration=$duration, bpm=$bpm, key=$key, peaks=$peaks, beats=$beats
  `).run({
    $filePath: track.filePath,
    $title: track.title,
    $artist: track.artist,
    $album: track.album,
    $genre: track.genre,
    $duration: track.duration,
    $bpm: track.bpm,
    $key: track.key,
    $peaks: track.peaks ? JSON.stringify(track.peaks) : null,
    $beats: track.beats ? JSON.stringify(track.beats) : null,
  });
}

export function getCollectionTrack(filePath: string): CollectionTrack | null {
  const row = db.prepare("SELECT * FROM collection_tracks WHERE filePath = ?").get(filePath) as {
    filePath: string; title: string; artist: string; album: string; genre: string;
    duration: number; bpm: number; key: string; peaks: string | null; beats: string | null; addedAt: string;
  } | null;
  if (!row) return null;

  const cues = getCuesForTrack(filePath);
  return {
    filePath: row.filePath,
    title: row.title,
    artist: row.artist,
    album: row.album,
    genre: row.genre,
    duration: row.duration,
    bpm: row.bpm,
    key: row.key,
    peaks: row.peaks ? JSON.parse(row.peaks) : null,
    beats: row.beats ? JSON.parse(row.beats) : null,
    cues,
    addedAt: row.addedAt,
  };
}

export function getAllCollectionTracks(): CollectionTrack[] {
  const rows = db.prepare("SELECT * FROM collection_tracks ORDER BY addedAt DESC").all() as {
    filePath: string; title: string; artist: string; album: string; genre: string;
    duration: number; bpm: number; key: string; peaks: string | null; beats: string | null; addedAt: string;
  }[];
  return rows.map((row) => ({
    filePath: row.filePath,
    title: row.title,
    artist: row.artist,
    album: row.album,
    genre: row.genre,
    duration: row.duration,
    bpm: row.bpm,
    key: row.key,
    peaks: row.peaks ? JSON.parse(row.peaks) : null,
    beats: row.beats ? JSON.parse(row.beats) : null,
    cues: getCuesForTrack(row.filePath),
    addedAt: row.addedAt,
  }));
}

export function getCuesForTrack(filePath: string): CuePoint[] {
  const rows = db.prepare("SELECT * FROM cue_points WHERE filePath = ? ORDER BY time").all(filePath) as {
    id: string; filePath: string; label: string; time: number; color: string; active: number;
  }[];

  return rows.map((row) => {
    const connections = db.prepare(
      "SELECT * FROM cue_connections WHERE sourceCueId = ?"
    ).all(row.id) as {
      id: string; sourceCueId: string; targetCueId: string; targetFilePath: string; action: string;
    }[];

    return {
      id: row.id,
      filePath: row.filePath,
      trackId: "",  // runtime-only, set when track is loaded
      label: row.label,
      time: row.time,
      color: row.color,
      active: row.active === 1,
      connections: connections.map((c) => ({
        id: c.id,
        cueId: c.targetCueId,
        targetFilePath: c.targetFilePath,
        action: c.action as CueConnection["action"],
      })),
    };
  });
}

export function upsertCue(cue: { id: string; filePath: string; label: string; time: number; color: string; active: boolean }): void {
  db.prepare(`
    INSERT INTO cue_points (id, filePath, label, time, color, active)
    VALUES ($id, $filePath, $label, $time, $color, $active)
    ON CONFLICT(id) DO UPDATE SET label=$label, time=$time, color=$color, active=$active
  `).run({
    $id: cue.id,
    $filePath: cue.filePath,
    $label: cue.label,
    $time: cue.time,
    $color: cue.color,
    $active: cue.active ? 1 : 0,
  });
}

export function deleteCue(id: string): void {
  db.prepare("DELETE FROM cue_connections WHERE sourceCueId = ? OR targetCueId = ?").run(id, id);
  db.prepare("DELETE FROM cue_points WHERE id = ?").run(id);
}

export function upsertConnection(conn: { id: string; sourceCueId: string; targetCueId: string; targetFilePath: string; action: string }): void {
  db.prepare(`
    INSERT INTO cue_connections (id, sourceCueId, targetCueId, targetFilePath, action)
    VALUES ($id, $sourceCueId, $targetCueId, $targetFilePath, $action)
    ON CONFLICT(id) DO UPDATE SET action=$action
  `).run({
    $id: conn.id,
    $sourceCueId: conn.sourceCueId,
    $targetCueId: conn.targetCueId,
    $targetFilePath: conn.targetFilePath,
    $action: conn.action,
  });
}

export function deleteConnection(id: string): void {
  db.prepare("DELETE FROM cue_connections WHERE id = ?").run(id);
}
