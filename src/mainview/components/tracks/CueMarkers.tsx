import { useCallback, useEffect, useMemo, useRef } from "react";
import { useCueStore } from "../../stores/cueStore.ts";
import { usePlayerStore } from "../../stores/playerStore.ts";
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
  beats?: number[];
  onCueDrag?: (time: number | null) => void;
}

function stop(e: React.MouseEvent) { e.stopPropagation(); }

export function CueMarkers({ cues, duration, containerWidth, trackId, beats, onCueDrag }: CueMarkersProps) {
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

  // Cancel pending connection on click outside targets or Escape
  const cancelConnection = useCueStore((s) => s.cancelConnection);
  useEffect(() => {
    if (!pendingConnection) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelConnection();
    };
    const handleClick = () => { cancelConnection(); };
    window.addEventListener("keydown", handleEscape);
    // Use bubble phase — target clicks call stopPropagation so won't reach here
    window.addEventListener("mousedown", handleClick);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [pendingConnection, cancelConnection]);

  const containerElRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    cueId: string;
    startX: number;
    containerRect: DOMRect;
    dragged: boolean;
  } | null>(null);

  const handleCueMouseDown = useCallback(
    (e: React.MouseEvent, cue: CuePoint) => {
      e.stopPropagation();
      e.preventDefault();
      if (pendingConnection) return;
      const container = containerElRef.current;
      if (!container || duration <= 0) return;

      dragRef.current = {
        cueId: cue.id,
        startX: e.clientX,
        containerRect: container.getBoundingClientRect(),
        dragged: false,
      };

      const onMove = (ev: MouseEvent) => {
        const state = dragRef.current;
        if (!state) return;
        if (!state.dragged && Math.abs(ev.clientX - state.startX) > 3) {
          state.dragged = true;
        }
        if (!state.dragged) return;

        const pct = Math.max(0, Math.min(1,
          (ev.clientX - state.containerRect.left) / state.containerRect.width
        ));
        let time = pct * duration;

        if (beats && beats.length > 0) {
          let nearest = beats[0] ?? 0;
          let minDist = Infinity;
          for (const bt of beats) {
            const d = Math.abs(bt - time);
            if (d < minDist) { minDist = d; nearest = bt; }
          }
          time = nearest;
        }

        useCueStore.getState().updateCue(state.cueId, { time });
        onCueDrag?.(time);
      };

      const onUp = () => {
        const state = dragRef.current;
        if (state && !state.dragged && cue.connections.length > 0) {
          void activateCue(trackId, cue);
        }
        if (state?.dragged) onCueDrag?.(null);
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [duration, beats, trackId, pendingConnection, onCueDrag]
  );

  if (cues.length === 0 || duration <= 0 || containerWidth <= 0) return null;

  const timeToX = (t: number) => (t / duration) * containerWidth;

  return (
    <div ref={containerElRef} className="absolute inset-0" style={{ overflow: "visible", zIndex: 10 }}>
      {/* Connection target highlights on other tracks — rendered with high z-index */}
      {isPendingTarget && cues.map((cue) => {
        const x = timeToX(cue.time);
        return (
          <div
            key={`target-${cue.id}`}
            className="absolute top-0 bottom-0 pointer-events-auto cursor-pointer"
            style={{ left: x - 12, width: 24, zIndex: 50 }}
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); completeConnection(cue.id); }}
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

        return (
          <div key={cue.id}>
            {/* Vertical marker line + hover area */}
            <div
              className="absolute top-0 bottom-0 pointer-events-auto cursor-ew-resize"
              style={{ left: x - 6, width: 12 }}
              onMouseEnter={() => keepCueHovered(cue.id)}
              onMouseLeave={() => releaseCueHover(cue.id)}
              onMouseDown={(e) => handleCueMouseDown(e, cue)}
            >
              <div
                className="absolute top-0 bottom-0"
                style={{ left: 5, width: 2, backgroundColor: cue.color }}
              />
            </div>

            {/* Label badge */}
            <div
              className="absolute pointer-events-auto cursor-ew-resize"
              style={{ left: x - 1, top: 0, zIndex: 10 }}
              onMouseEnter={() => keepCueHovered(cue.id)}
              onMouseLeave={() => releaseCueHover(cue.id)}
              onMouseDown={(e) => handleCueMouseDown(e, cue)}
            >
              <div
                className="px-1 py-px text-[8px] font-bold font-mono rounded-b leading-tight"
                style={{ backgroundColor: cue.color, color: "#000" }}
              >
                {cue.label}
                {cue.connections.map((conn) => {
                  const target = allCuesMap.get(conn.cueId);
                  if (!target) return null;
                  return (
                    <span key={conn.cueId} className="ml-0.5 opacity-70">→{target.label}:{ACTION_LABELS[conn.action]}</span>
                  );
                })}
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
                      const trackState = usePlayerStore.getState().tracks.get(trackId);
                      const bpm = trackState?.track.bpm ?? 120;
                      const fourBars = 4 * (60 / bpm) * 4; // 4 bars = 16 beats
                      window.djRpc?.request?.setLoop?.({ trackId, startSec: cue.time, endSec: cue.time + fourBars });
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
                  {cue.connections.map((conn) => {
                    const target = allCuesMap.get(conn.cueId);
                    if (!target) return null;
                    return (
                      <div key={conn.cueId} className="flex items-center px-2 py-0.5 gap-1">
                        <button
                          className="text-[9px] text-amber-300 hover:bg-zinc-700 rounded px-0.5"
                          onClick={() => {
                            const idx = ACTION_ORDER.indexOf(conn.action);
                            const next = ACTION_ORDER[(idx + 1) % ACTION_ORDER.length]!;
                            const updated = cue.connections.map((c) =>
                              c.cueId === conn.cueId ? { ...c, action: next } : c
                            );
                            useCueStore.getState().updateCue(cue.id, { connections: updated });
                          }}
                        >
                          →{target.label}:{ACTION_LABELS[conn.action]} ↻
                        </button>
                        <button
                          className="text-[9px] text-red-400 hover:bg-zinc-700 rounded px-0.5"
                          onClick={() => {
                            useCueStore.getState().removeConnection(cue.id, conn.cueId);
                            setHoveredCue(null);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
