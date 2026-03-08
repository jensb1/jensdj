import { useEffect, useState, useRef, useCallback } from "react";
import { TrackList } from "../tracks/TrackList.tsx";
import { LibraryPanel } from "../library/LibraryPanel.tsx";
import { CueTable } from "../cues/CueTable.tsx";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { useCueStore } from "../../stores/cueStore.ts";
import { syncPlay } from "../../utils/syncPlay.ts";
import { Button } from "../ui/button.tsx";
import { logError, logInfo, logWarn } from "../../lib/debugLog.ts";

function MasterTempo() {
  const masterBpm = usePlayerStore((s) => s.masterBpm);
  const setMasterBpm = usePlayerStore((s) => s.setMasterBpm);
  const tracks = usePlayerStore((s) => s.tracks);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  const applyBpm = (bpm: number) => {
    setMasterBpm(bpm);
    window.djRpc?.request?.setMasterBpm?.({ bpm });
  };

  const handleSubmit = () => {
    const val = parseFloat(editValue);
    if (val > 0 && val <= 300) applyBpm(val);
    setEditing(false);
  };

  // Find first track with BPM for "Sync" button
  const firstTrackBpm = (() => {
    for (const [, state] of tracks) {
      if (state.track.metadata.bpm > 0) return state.track.metadata.bpm;
    }
    return 0;
  })();

  return (
    <div className="flex items-center gap-1.5 ml-4 px-2 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/50">
      <span className="text-[9px] text-zinc-500 font-semibold uppercase">Master</span>
      {editing ? (
        <input
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") setEditing(false);
          }}
          autoFocus
          className="w-14 h-5 text-[10px] font-mono font-bold text-center bg-zinc-700 text-emerald-300 border border-emerald-500/50 rounded outline-none"
        />
      ) : (
        <span
          className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded cursor-pointer hover:bg-zinc-700/50"
          style={{ color: masterBpm > 0 ? "#34d399" : "#71717a" }}
          onClick={() => {
            setEditValue(masterBpm > 0 ? masterBpm.toFixed(1) : firstTrackBpm > 0 ? firstTrackBpm.toFixed(1) : "");
            setEditing(true);
          }}
        >
          {masterBpm > 0 ? masterBpm.toFixed(1) : "OFF"}
        </span>
      )}
      <button
        onClick={() => applyBpm(Math.max(1, masterBpm - 0.1))}
        className="text-[10px] text-zinc-500 hover:text-zinc-300 px-0.5"
        disabled={masterBpm === 0}
      >-</button>
      <button
        onClick={() => applyBpm(masterBpm > 0 ? masterBpm + 0.1 : firstTrackBpm > 0 ? firstTrackBpm : 120)}
        className="text-[10px] text-zinc-500 hover:text-zinc-300 px-0.5"
      >+</button>
      {masterBpm > 0 && (
        <button
          onClick={() => applyBpm(0)}
          className="text-[8px] text-zinc-600 hover:text-red-400 px-1"
          title="Disable master tempo"
        >
          OFF
        </button>
      )}
    </div>
  );
}

export function MainLayout() {
  const [loading, setLoading] = useState(false);
  const addTrack = usePlayerStore((s) => s.addTrack);
  const setDevices = usePlayerStore((s) => s.setDevices);
  const [libraryHeight, setLibraryHeight] = useState(280);
  const draggingRef = useRef(false);

  // Helper: add track to player store + load persisted cues
  const addTrackAndLoadCues = useCallback((track: import("../../../shared/types.ts").LoadedTrack) => {
    addTrack(track);
    useCueStore.getState().loadCuesForTrack(track.filePath, track.id);
  }, [addTrack]);

  useEffect(() => {
    window.djRpc?.request?.getOutputDevices?.({} as never)?.then((devices) => {
      if (devices) setDevices(devices);
    });
    // Auto-load two test tracks for faster testing
    const autoLoad = async () => {
      const testPath1 = "/Users/jensberlips/Development/jensdj/test-assets/beat100.mp3";
      const testPath2 = "/Users/jensberlips/Development/jensdj/test-assets/beat125.mp3";
      try {
        const t1 = await window.djRpc?.request?.loadTrack?.({ filePath: testPath1 });
        if (t1) addTrackAndLoadCues(t1);
        const t2 = await window.djRpc?.request?.loadTrack?.({ filePath: testPath2 });
        if (t2) addTrackAndLoadCues(t2);
        logInfo("library.autoLoad", { count: 2, tracks: [testPath1, testPath2] });
      } catch (e) {
        logWarn("library.autoLoadFailed", { error: String(e) });
      }
    };
    autoLoad();
  }, [setDevices, addTrackAndLoadCues]);

  const handleAddTrack = async () => {
    setLoading(true);
    try {
      const files = await window.djRpc?.request?.openFileDialog?.({} as never);
      if (files && files.length > 0) {
        for (const filePath of files) {
          const track = await window.djRpc?.request?.loadTrack?.({ filePath });
          if (track) addTrackAndLoadCues(track);
        }
      }
    } catch (e) {
      logError("library.loadTrackFailed", { error: String(e) });
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
        addTrackAndLoadCues(track);
        if (pathInputRef.current) pathInputRef.current.value = "";
      }
    } catch (e) {
      logError("library.loadPathFailed", { error: String(e), filePath });
    }
    setLoading(false);
  };

  const handleLoadTestTrack = async () => {
    setLoading(true);
    try {
      const filePath = "/Users/jensberlips/Development/jensdj/test-assets/beat100.mp3";
      const track = await window.djRpc?.request?.loadTrack?.({ filePath });
      if (track) addTrackAndLoadCues(track);
    } catch (e) {
      logError("library.testLoadFailed", { error: String(e) });
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
          syncPlay(targetId);
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
        <MasterTempo />
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

      {/* Library + Cue panel */}
      <div style={{ height: libraryHeight }} className="shrink-0 overflow-hidden flex">
        <div className="flex-1 overflow-hidden border-r border-zinc-800">
          <LibraryPanel />
        </div>
        <div className="w-[380px] shrink-0 overflow-hidden">
          <CueTable />
        </div>
      </div>

      {/* Status bar */}
      <div className="h-6 flex items-center px-4 bg-zinc-900 border-t border-zinc-800 text-zinc-600 text-[10px]">
        <span>Native engine active</span>
        <span className="ml-auto">{usePlayerStore.getState().tracks.size} tracks loaded</span>
      </div>
    </div>
  );
}
