import { useMemo } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { useCueStore } from "../../stores/cueStore.ts";
import type { CuePoint, ConnectionAction } from "../../../shared/types.ts";

const ACTION_LABELS: Record<ConnectionAction, string> = {
  start: "Start",
  stop: "Stop",
  loop: "Loop",
};

function formatCueTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
}

export function CueTable() {
  const selectedTrackId = usePlayerStore((s) => s.selectedTrackId);
  const tracks = usePlayerStore((s) => s.tracks);
  const cuesMap = useCueStore((s) => s.cues);
  const toggleActive = useCueStore((s) => s.toggleActive);
  const removeCue = useCueStore((s) => s.removeCue);
  const addOrToggleCue = useCueStore((s) => s.addOrToggleCue);

  const selectedTrack = selectedTrackId ? tracks.get(selectedTrackId) : null;

  const trackCues = useMemo(() => {
    if (!selectedTrackId) return [];
    const result: CuePoint[] = [];
    for (const cue of cuesMap.values()) {
      if (cue.trackId === selectedTrackId) result.push(cue);
    }
    return result.sort((a, b) => a.time - b.time);
  }, [cuesMap, selectedTrackId]);

  const allCuesMap = cuesMap;

  if (!selectedTrackId || !selectedTrack) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-600 text-[11px]">
        Select a track to view cues
      </div>
    );
  }

  const handleAddCue = () => {
    const pos = selectedTrack.lockedPosition ?? selectedTrack.previewPosition ?? selectedTrack.position;
    addOrToggleCue(selectedTrackId, selectedTrack.track.filePath, pos, selectedTrack.track.beats);
  };

  const handleSeekToCue = (cue: CuePoint) => {
    usePlayerStore.getState().setLockedPosition(selectedTrackId, cue.time);
    usePlayerStore.getState().setPreviewPosition(selectedTrackId, cue.time);
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider shrink-0">Cues</span>
          <span className="text-[10px] text-zinc-500 truncate">
            {selectedTrack.track.metadata.title}
          </span>
        </div>
        <button
          onClick={handleAddCue}
          className="px-2 py-0.5 text-[9px] font-bold uppercase rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-700/50 hover:border-zinc-500 shrink-0"
        >
          + CUE
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {trackCues.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-[10px]">
            No cues yet
          </div>
        ) : (
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-800/50">
                <th className="text-left px-2 py-1 font-medium w-12">Label</th>
                <th className="text-left px-2 py-1 font-medium w-16">Time</th>
                <th className="text-center px-2 py-1 font-medium w-10">Active</th>
                <th className="text-left px-2 py-1 font-medium">Connections</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {trackCues.map((cue) => (
                <tr
                  key={cue.id}
                  className="border-b border-zinc-800/30 hover:bg-zinc-800/30 cursor-pointer"
                  onClick={() => handleSeekToCue(cue)}
                >
                  <td className="px-2 py-1">
                    <span
                      className="inline-block px-1.5 py-px rounded text-[9px] font-bold font-mono"
                      style={{ backgroundColor: cue.color + "30", color: cue.color }}
                    >
                      {cue.label}
                    </span>
                  </td>
                  <td className="px-2 py-1 font-mono text-zinc-300">
                    {formatCueTime(cue.time)}
                  </td>
                  <td className="px-2 py-1 text-center">
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleActive(cue.id); }}
                      className={`w-5 h-5 rounded-full border-2 transition-colors ${
                        cue.active
                          ? "border-emerald-400 bg-emerald-400/20"
                          : "border-zinc-600 bg-transparent hover:border-zinc-400"
                      }`}
                      title={cue.active ? "Deactivate" : "Activate"}
                    >
                      {cue.active && (
                        <span className="text-emerald-400 text-[8px]">●</span>
                      )}
                    </button>
                  </td>
                  <td className="px-2 py-1 text-zinc-500">
                    {cue.connections.length === 0 ? (
                      <span className="text-zinc-700">—</span>
                    ) : (
                      cue.connections.map((conn) => {
                        const target = allCuesMap.get(conn.cueId);
                        return (
                          <span key={conn.id} className="mr-1 text-amber-400/70">
                            →{target?.label ?? "?"}: {ACTION_LABELS[conn.action]}
                          </span>
                        );
                      })
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); removeCue(cue.id); }}
                      className="text-zinc-600 hover:text-red-400 text-[10px]"
                      title="Delete cue"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
