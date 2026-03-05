import { useMemo } from "react";
import { useCueStore } from "../../stores/cueStore.ts";
import type { CuePoint } from "../../../shared/types.ts";

interface CueToolbarProps {
  trackId: string;
  getPosition: () => number;
  beats?: number[];
}

export function CueToolbar({ trackId, getPosition, beats }: CueToolbarProps) {
  const cuesMap = useCueStore((s) => s.cues);
  const addCue = useCueStore((s) => s.addCue);
  const removeCue = useCueStore((s) => s.removeCue);
  const pendingConnection = useCueStore((s) => s.pendingConnection);
  const cancelConnection = useCueStore((s) => s.cancelConnection);
  const completeConnection = useCueStore((s) => s.completeConnection);

  const pendingSource = pendingConnection ? cuesMap.get(pendingConnection) : null;
  const isPendingSource = pendingSource?.trackId === trackId;
  const isPendingTarget = pendingSource != null && pendingSource.trackId !== trackId;

  const cues = useMemo(() => {
    const result: CuePoint[] = [];
    for (const cue of cuesMap.values()) {
      if (cue.trackId === trackId) result.push(cue);
    }
    return result.sort((a, b) => a.time - b.time);
  }, [cuesMap, trackId]);

  const handleAddCue = () => {
    let time = getPosition();

    // Snap to nearest beat
    if (beats && beats.length > 0) {
      let nearest = beats[0] ?? 0;
      let minDist = Infinity;
      for (const bt of beats) {
        const d = Math.abs(bt - time);
        if (d < minDist) { minDist = d; nearest = bt; }
      }
      time = nearest;
    }

    addCue(trackId, time);
  };

  const handleJumpTo = (cue: CuePoint) => {
    window.djRpc?.request?.seek?.({ trackId, seconds: cue.time });
  };

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={handleAddCue}
        className="px-1.5 py-0.5 text-[8px] font-bold uppercase rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-700/50 hover:border-zinc-500"
      >
        CUE
      </button>
      {cues.map((cue) => (
        <span key={cue.id} className="group flex items-center gap-0.5">
          <span
            className={`px-1 py-0.5 text-[7px] font-bold rounded cursor-pointer hover:opacity-80 ${
              isPendingTarget ? "ring-1 ring-amber-400 animate-pulse" : ""
            }`}
            style={{ backgroundColor: cue.color + "20", color: cue.color }}
            onClick={() => isPendingTarget ? completeConnection(cue.id) : handleJumpTo(cue)}
            title={isPendingTarget
              ? `Click to connect ${pendingSource!.label} → ${cue.label}`
              : `${cue.label} @ ${cue.time.toFixed(2)}s — click to jump`
            }
          >
            {cue.label}
          </span>
          <span
            className="text-[7px] text-zinc-600 cursor-pointer hover:text-red-400 hidden group-hover:inline"
            onClick={() => removeCue(cue.id)}
            title="Remove cue"
          >
            ✕
          </span>
        </span>
      ))}
      {isPendingSource && (
        <span className="text-[8px] text-amber-400 ml-1">
          Select target on other track
          <span
            className="ml-1 text-zinc-500 cursor-pointer hover:text-red-400"
            onClick={cancelConnection}
          >✕</span>
        </span>
      )}
    </div>
  );
}
