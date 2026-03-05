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
