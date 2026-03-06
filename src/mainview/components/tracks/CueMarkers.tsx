import { useCallback, useEffect, useMemo, useRef } from "react";
import { useCueStore } from "../../stores/cueStore.ts";
import type { CuePoint, ConnectionAction } from "../../../shared/types.ts";
import { activateCue } from "../../utils/cueActions.ts";

const ACTION_LABELS: Record<ConnectionAction, string> = {
  start: "Start",
  stop: "Stop",
  loop: "Loop",
};
const ACTION_ORDER: ConnectionAction[] = ["start", "stop", "loop"];

interface CueMarkersProps {
  cues: CuePoint[];
  duration: number;
  containerWidth: number;
  trackId: string;
}

function stop(e: React.MouseEvent) { e.stopPropagation(); }

export function CueMarkers({ cues, duration, containerWidth, trackId }: CueMarkersProps) {
  const hoveredCue = useCueStore((s) => s.hoveredCueId);
  const setHoveredCue = useCueStore((s) => s.setHoveredCueId);
  const pendingConnection = useCueStore((s) => s.pendingConnection);
  const allCuesMap = useCueStore((s) => s.cues);
  const startConnection = useCueStore((s) => s.startConnection);
  const completeConnection = useCueStore((s) => s.completeConnection);

  const otherTrackCues = useMemo(() => {
    const result: CuePoint[] = [];
    for (const cue of allCuesMap.values()) {
      if (cue.trackId !== trackId) result.push(cue);
    }
    return result;
  }, [allCuesMap, trackId]);

  const pendingSource = pendingConnection ? allCuesMap.get(pendingConnection) : null;
  const isPendingTarget = pendingSource && pendingSource.trackId !== trackId;
  const hoverTimeoutRef = useRef<number>(0);

  const keepCueHovered = useCallback((cueId: string) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = 0;
    }
    setHoveredCue(cueId);
  }, [setHoveredCue]);

  const releaseCueHover = useCallback((cueId: string) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    hoverTimeoutRef.current = window.setTimeout(() => {
      if (useCueStore.getState().hoveredCueId === cueId) {
        useCueStore.getState().setHoveredCueId(null);
      }
      hoverTimeoutRef.current = 0;
    }, 140);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  if (cues.length === 0 || duration <= 0 || containerWidth <= 0) return null;

  const timeToX = (t: number) => (t / duration) * containerWidth;

  return (
    <div className="absolute inset-0" style={{ overflow: "visible", zIndex: 10 }}>
      {/* Connection target highlights on other tracks */}
      {isPendingTarget && cues.map((cue) => {
        const x = timeToX(cue.time);
        return (
          <div
            key={`target-${cue.id}`}
            className="absolute top-0 bottom-0 pointer-events-auto cursor-pointer"
            style={{ left: x - 12, width: 24 }}
            onMouseDown={(e) => { stop(e); completeConnection(cue.id); }}
          >
            <div
              className="absolute px-1.5 py-0.5 text-[9px] font-bold font-mono rounded animate-pulse"
              style={{
                left: 8, top: -14,
                backgroundColor: "#fbbf24",
                color: "#000",
                whiteSpace: "nowrap",
              }}
            >
              → {cue.label}
            </div>
            <div className="absolute top-0 bottom-0" style={{ left: 11, width: 2, backgroundColor: "#fbbf24" }} />
          </div>
        );
      })}

      {cues.map((cue) => {
        const x = timeToX(cue.time);
        const isHovered = hoveredCue === cue.id;
        const isConnected = !!cue.connectedCueId;
        const connectedCue = cue.connectedCueId ? allCuesMap.get(cue.connectedCueId) : null;

        return (
          <div key={cue.id}>
            {/* Vertical marker line + hover area */}
            <div
              className="absolute top-0 bottom-0 pointer-events-auto"
              style={{ left: x - 6, width: 12 }}
              onMouseEnter={() => keepCueHovered(cue.id)}
              onMouseLeave={() => releaseCueHover(cue.id)}
              onMouseDown={stop}
              onClick={() => { void activateCue(trackId, cue); }}
            >
              <div
                className="absolute top-0 bottom-0"
                style={{ left: 5, width: 2, backgroundColor: cue.color }}
              />
            </div>

            {/* Label badge */}
            <div
              className="absolute pointer-events-auto cursor-pointer"
              style={{ left: x - 1, top: 0, zIndex: 10 }}
              onMouseEnter={() => keepCueHovered(cue.id)}
              onMouseLeave={() => releaseCueHover(cue.id)}
              onMouseDown={stop}
              onClick={() => { void activateCue(trackId, cue); }}
            >
              <div
                className="px-1 py-px text-[8px] font-bold font-mono rounded-b leading-tight"
                style={{ backgroundColor: cue.color, color: "#000" }}
              >
                {cue.label}
                {isConnected && connectedCue && (
                  <span className="ml-0.5 opacity-70">→{connectedCue.label}:{ACTION_LABELS[cue.connectionAction ?? "start"]}</span>
                )}
              </div>
            </div>

            {/* Hover popup menu */}
            {isHovered && !pendingConnection && (
              <div
                className="absolute pointer-events-auto z-30"
                style={{ left: x - 1, top: 14 }}
                onMouseEnter={() => keepCueHovered(cue.id)}
                onMouseLeave={() => releaseCueHover(cue.id)}
                onMouseDown={stop}
              >
                <div className="bg-zinc-800 border border-zinc-600 rounded shadow-lg py-0.5 min-w-[90px]">
                  <button
                    className="block w-full text-left px-2 py-0.5 text-[9px] text-zinc-200 hover:bg-zinc-700"
                    onClick={() => {
                      window.djRpc?.request?.setLoop?.({ trackId, startSec: cue.time, endSec: cue.time + 4 * (60 / 120) });
                      setHoveredCue(null);
                    }}
                  >
                    Loop (4 bars)
                  </button>
                  {otherTrackCues.length > 0 && (
                    <button
                      className="block w-full text-left px-2 py-0.5 text-[9px] text-zinc-200 hover:bg-zinc-700"
                      onClick={() => { startConnection(cue.id); setHoveredCue(null); }}
                    >
                      Connect →
                    </button>
                  )}
                  {isConnected && (
                    <button
                      className="block w-full text-left px-2 py-0.5 text-[9px] text-amber-300 hover:bg-zinc-700"
                      onClick={() => {
                        const cur = cue.connectionAction ?? "start";
                        const idx = ACTION_ORDER.indexOf(cur);
                        const next = ACTION_ORDER[(idx + 1) % ACTION_ORDER.length]!;
                        useCueStore.getState().updateCue(cue.id, { connectionAction: next });
                      }}
                    >
                      Action: {ACTION_LABELS[cue.connectionAction ?? "start"]} ↻
                    </button>
                  )}
                  {isConnected && (
                    <button
                      className="block w-full text-left px-2 py-0.5 text-[9px] text-red-400 hover:bg-zinc-700"
                      onClick={() => {
                        useCueStore.getState().updateCue(cue.id, { connectedCueId: undefined, connectedTrackId: undefined, connectionAction: undefined });
                        if (connectedCue) {
                          useCueStore.getState().updateCue(connectedCue.id, { connectedCueId: undefined, connectedTrackId: undefined, connectionAction: undefined });
                        }
                        setHoveredCue(null);
                      }}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
