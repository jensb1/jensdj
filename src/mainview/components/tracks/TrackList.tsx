import { useRef, useEffect, useCallback, useState } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { useBeatDragStore } from "../../stores/beatDragStore.ts";
import { useConnectionStore } from "../../stores/connectionStore.ts";
import { TrackRow } from "./TrackRow.tsx";
import { BeatConnections } from "./BeatConnections.tsx";
import { ConnectionMonitor } from "./ConnectionMonitor.tsx";

interface TrackLayout {
  trackId: string;
  top: number;
  left: number;
  width: number;
  height: number;
  duration: number;
}

export function TrackList() {
  const tracks = usePlayerStore((s) => s.tracks);
  const trackEntries = Array.from(tracks.entries());
  const containerRef = useRef<HTMLDivElement>(null);
  const waveformRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [trackLayouts, setTrackLayouts] = useState<Map<string, TrackLayout>>(new Map());

  // Recalculate waveform positions for SVG overlay
  const updateLayouts = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const layouts = new Map<string, TrackLayout>();

    for (const [trackId, state] of tracks.entries()) {
      const el = waveformRefs.current.get(trackId);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      layouts.set(trackId, {
        trackId,
        top: rect.top - containerRect.top,
        left: rect.left - containerRect.left,
        width: rect.width,
        height: rect.height,
        duration: state.track.duration,
      });
    }
    setTrackLayouts(layouts);
  }, [tracks]);

  useEffect(() => {
    updateLayouts();
    const observer = new ResizeObserver(updateLayouts);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [updateLayouts]);

  // Also update after tracks change
  useEffect(() => {
    // Small delay to let DOM settle after track add/remove
    const t = setTimeout(updateLayouts, 100);
    return () => clearTimeout(t);
  }, [trackEntries.length, updateLayouts]);

  // Global mouse move/up for beat dragging across tracks
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = useBeatDragStore.getState().drag;
      if (drag) {
        useBeatDragStore.getState().updateDrag(e.clientX, e.clientY);
      }
    };
    const onUp = (e: MouseEvent) => {
      const drag = useBeatDragStore.getState().drag;
      if (!drag) return;

      // Find which waveform the mouse is over
      const container = containerRef.current;
      if (!container) {
        useBeatDragStore.getState().endDrag();
        return;
      }

      for (const [trackId, layout] of trackLayouts.entries()) {
        if (trackId === drag.sourceTrackId) continue;
        const containerRect = container.getBoundingClientRect();
        const absTop = containerRect.top + layout.top;
        const absLeft = containerRect.left + layout.left;

        if (
          e.clientX >= absLeft &&
          e.clientX <= absLeft + layout.width &&
          e.clientY >= absTop &&
          e.clientY <= absTop + layout.height
        ) {
          // Find nearest BAR beat (every 4th = "1" beat) in target track
          const trackState = tracks.get(trackId);
          if (trackState && trackState.track.beats.length > 0) {
            const relX = e.clientX - absLeft;
            const pct = relX / layout.width;
            const time = pct * layout.duration;

            let closestBeat = trackState.track.beats[0] ?? 0;
            let minDist = Infinity;
            for (let i = 0; i < trackState.track.beats.length; i += 4) {
              const bt = trackState.track.beats[i] ?? 0;
              const dist = Math.abs(bt - time);
              if (dist < minDist) {
                minDist = dist;
                closestBeat = bt;
              }
            }

            useConnectionStore.getState().addConnection({
              sourceTrackId: drag.sourceTrackId,
              sourceBeatTime: drag.sourceBeatTime,
              targetTrackId: trackId,
              targetBeatTime: closestBeat,
            });
            // No auto-play — ConnectionMonitor triggers when source reaches the beat
          }
          break;
        }
      }

      useBeatDragStore.getState().endDrag();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [trackLayouts, tracks]);

  // Register waveform ref callback
  const registerWaveformRef = useCallback((trackId: string, el: HTMLDivElement | null) => {
    if (el) {
      waveformRefs.current.set(trackId, el);
    } else {
      waveformRefs.current.delete(trackId);
    }
  }, []);

  if (trackEntries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center h-full text-zinc-600">
        <div className="text-center">
          <div className="text-5xl mb-4 opacity-30">&#9835;</div>
          <div className="text-sm font-medium">No tracks loaded</div>
          <div className="text-xs mt-1 text-zinc-700">
            Click "+ Add Track" or double-click a library track
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto relative">
      {trackEntries.map(([id, state]) => (
        <TrackRow
          key={id}
          trackId={id}
          state={state}
          onWaveformRef={(el) => registerWaveformRef(id, el)}
        />
      ))}
      <BeatConnections trackLayouts={trackLayouts} />
      <ConnectionMonitor />
    </div>
  );
}
