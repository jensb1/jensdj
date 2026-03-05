import { useEffect, useCallback, useState, useRef } from "react";
import { useLibraryStore } from "../../stores/libraryStore.ts";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { SearchBar } from "./SearchBar.tsx";
import { TrackTable } from "./TrackTable.tsx";
import { Button } from "../ui/button.tsx";
import type { SortingState } from "@tanstack/react-table";
import type { TrackMetadata } from "../../../shared/types.ts";

export function LibraryPanel() {
  const tracks = useLibraryStore((s) => s.tracks);
  const query = useLibraryStore((s) => s.query);
  const scanning = useLibraryStore((s) => s.scanning);
  const scanProgress = useLibraryStore((s) => s.scanProgress);
  const setQuery = useLibraryStore((s) => s.setQuery);
  const setTracks = useLibraryStore((s) => s.setTracks);
  const setScanning = useLibraryStore((s) => s.setScanning);
  const setScanProgress = useLibraryStore((s) => s.setScanProgress);
  const addTrack = usePlayerStore((s) => s.addTrack);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [loading, setLoading] = useState(false);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // Fetch library on mount and when query/sort changes
  const fetchLibrary = useCallback(async () => {
    const sortBy = sorting[0]?.id ?? "title";
    const sortDir = sorting[0]?.desc ? "desc" : "asc";
    const results = await window.djRpc?.request?.searchLibrary?.({
      query: query,
      sortBy,
      sortDir,
    });
    if (results) setTracks(results);
  }, [query, sorting, setTracks]);

  useEffect(() => {
    fetchLibrary();
  }, [fetchLibrary]);

  // Listen for scan progress
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setScanProgress(detail);
    };
    window.addEventListener("dj:scanProgress", handler);
    return () => window.removeEventListener("dj:scanProgress", handler);
  }, [setScanProgress]);

  // Scan a directory
  const handleScanPath = useCallback(async () => {
    const dirPath = pathInputRef.current?.value?.trim();
    if (!dirPath) return;
    setScanning(true);
    try {
      await window.djRpc?.request?.scanDirectory?.({ dirPath });
      if (pathInputRef.current) pathInputRef.current.value = "";
      await fetchLibrary();
    } catch (e) {
      console.error("[Library] Scan failed:", e);
    }
    setScanning(false);
    setScanProgress(null);
  }, [setScanning, setScanProgress, fetchLibrary]);

  // Double-click to load track into player
  const handleLoadTrack = useCallback(
    async (track: TrackMetadata) => {
      setLoading(true);
      try {
        const loaded = await window.djRpc?.request?.loadTrack?.({
          filePath: track.filePath,
        });
        if (loaded) addTrack(loaded);
      } catch (e) {
        console.error("[Library] Load failed:", e);
      }
      setLoading(false);
    },
    [addTrack]
  );

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Library toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-t border-zinc-800">
        <span className="text-zinc-500 text-[10px] font-semibold tracking-widest uppercase mr-1">
          Library
        </span>
        <SearchBar value={query} onChange={setQuery} />
        <div className="flex items-center gap-1 ml-auto">
          <input
            ref={pathInputRef}
            type="text"
            placeholder="Folder path to scan..."
            onKeyDown={(e) => e.key === "Enter" && handleScanPath()}
            className="h-7 px-2 text-[11px] bg-zinc-800 text-zinc-300 border border-zinc-700 rounded placeholder-zinc-600 focus:border-indigo-500 focus:outline-none w-56"
          />
          <Button onClick={handleScanPath} disabled={scanning} variant="secondary" size="sm">
            {scanning ? "Scanning..." : "Scan Folder"}
          </Button>
        </div>
        <span className="text-zinc-600 text-[10px] ml-2">
          {tracks.length} tracks
          {scanProgress && ` — ${scanProgress.current}/${scanProgress.total}`}
        </span>
      </div>

      {/* Track table */}
      <div className="flex-1 overflow-hidden">
        <TrackTable
          tracks={tracks}
          sorting={sorting}
          onSortingChange={setSorting}
          onDoubleClick={handleLoadTrack}
        />
      </div>

      {loading && (
        <div className="absolute bottom-8 right-4 text-[10px] text-indigo-400 bg-zinc-900 px-2 py-1 rounded border border-zinc-800">
          Loading track...
        </div>
      )}
    </div>
  );
}
