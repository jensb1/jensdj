import { useRef, useEffect, useCallback, useState } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { TrackRow } from "./TrackRow.tsx";
import { CueConnections } from "./CueConnections.tsx";
import { CueMonitor } from "./CueMonitor.tsx";

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

  useEffect(() => {
    const t = setTimeout(updateLayouts, 100);
    return () => clearTimeout(t);
  }, [trackEntries.length, updateLayouts]);

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
      <CueConnections trackLayouts={trackLayouts} />
      <CueMonitor />
    </div>
  );
}
