import { useEffect, useState, useRef, useCallback } from "react";
import { TrackList } from "../tracks/TrackList.tsx";
import { LibraryPanel } from "../library/LibraryPanel.tsx";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { Button } from "../ui/button.tsx";

export function MainLayout() {
  const [loading, setLoading] = useState(false);
  const addTrack = usePlayerStore((s) => s.addTrack);
  const setDevices = usePlayerStore((s) => s.setDevices);
  const [libraryHeight, setLibraryHeight] = useState(280);
  const draggingRef = useRef(false);

  useEffect(() => {
    window.djRpc?.request?.getOutputDevices?.({} as never)?.then((devices) => {
      if (devices) setDevices(devices);
    });
  }, [setDevices]);

  const handleAddTrack = async () => {
    setLoading(true);
    try {
      const files = await window.djRpc?.request?.openFileDialog?.({} as never);
      if (files && files.length > 0) {
        for (const filePath of files) {
          const track = await window.djRpc?.request?.loadTrack?.({ filePath });
          if (track) addTrack(track);
        }
      }
    } catch (e) {
      console.error("[UI] Failed to load track:", e);
    }
    setLoading(false);
  };

  const pathInputRef = useRef<HTMLInputElement>(null);

  const handleLoadPath = async () => {
    const filePath = pathInputRef.current?.value?.trim();
    if (!filePath) return;
    setLoading(true);
    try {
      const track = await window.djRpc?.request?.loadTrack?.({ filePath });
      if (track) {
        addTrack(track);
        if (pathInputRef.current) pathInputRef.current.value = "";
      }
    } catch (e) {
      console.error("[UI] Load failed:", e);
    }
    setLoading(false);
  };

  const handleLoadTestTrack = async () => {
    setLoading(true);
    try {
      const filePath = "/Volumes/MUSIC/all/acid pauli - nana.mp3";
      const track = await window.djRpc?.request?.loadTrack?.({ filePath });
      if (track) addTrack(track);
    } catch (e) {
      console.error("[UI] Test load failed:", e);
    }
    setLoading(false);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      // Space: play/pause the first playing track, or the first track
      if (e.code === "Space") {
        e.preventDefault();
        const tracks = usePlayerStore.getState().tracks;
        if (tracks.size === 0) return;
        // Find first playing track, or first track
        let targetId: string | null = null;
        for (const [id, st] of tracks.entries()) {
          if (st.isPlaying) { targetId = id; break; }
        }
        if (!targetId) targetId = tracks.keys().next().value ?? null;
        if (!targetId) return;
        const st = tracks.get(targetId);
        if (st?.isPlaying) {
          window.djRpc?.request?.pause?.({ trackId: targetId });
          usePlayerStore.getState().setPlaying(targetId, false);
        } else {
          window.djRpc?.request?.play?.({ trackId: targetId });
          usePlayerStore.getState().setPlaying(targetId, true);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Resizable divider
  const handleDividerMouseDown = useCallback(() => {
    draggingRef.current = true;
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const windowH = window.innerHeight;
      const newH = windowH - e.clientY;
      setLibraryHeight(Math.max(100, Math.min(windowH - 200, newH)));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border-b border-zinc-800">
        <span className="text-zinc-500 text-[11px] font-semibold tracking-widest uppercase mr-3">
          JensDJ
        </span>
        <Button onClick={handleAddTrack} disabled={loading} size="sm">
          {loading ? "Loading..." : "+ Add Track"}
        </Button>
        <Button onClick={handleLoadTestTrack} disabled={loading} variant="secondary" size="sm">
          Test Load
        </Button>
        <div className="flex items-center gap-1 ml-2">
          <input
            ref={pathInputRef}
            type="text"
            placeholder="Paste file path..."
            onKeyDown={(e) => e.key === "Enter" && handleLoadPath()}
            className="h-7 px-2 text-[11px] bg-zinc-800 text-zinc-300 border border-zinc-700 rounded placeholder-zinc-600 focus:border-indigo-500 focus:outline-none w-64"
          />
          <Button onClick={handleLoadPath} disabled={loading} variant="secondary" size="sm">
            Load
          </Button>
        </div>
      </div>

      {/* Track area */}
      <div className="flex-1 overflow-hidden">
        <TrackList />
      </div>

      {/* Resizable divider */}
      <div
        onMouseDown={handleDividerMouseDown}
        className="h-1 bg-zinc-800 hover:bg-indigo-500/50 cursor-row-resize transition-colors"
      />

      {/* Library panel */}
      <div style={{ height: libraryHeight }} className="shrink-0 overflow-hidden">
        <LibraryPanel />
      </div>

      {/* Status bar */}
      <div className="h-6 flex items-center px-4 bg-zinc-900 border-t border-zinc-800 text-zinc-600 text-[10px]">
        <span>Native engine active</span>
        <span className="ml-auto">{usePlayerStore.getState().tracks.size} tracks loaded</span>
      </div>
    </div>
  );
}
