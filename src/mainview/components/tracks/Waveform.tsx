import { useRef, useEffect, useCallback } from "react";
import { useBeatDragStore } from "../../stores/beatDragStore.ts";
import { useConnectionStore } from "../../stores/connectionStore.ts";

interface WaveformProps {
  trackId: string;
  peaks: number[];
  duration: number;
  beats?: number[];
  downbeatOffset?: number;
  onSeek: (seconds: number) => void;
  onContainerRef?: (el: HTMLDivElement | null) => void;
}

const BEAT_SNAP_PX = 8; // pixels proximity to snap to a beat

export function Waveform({ trackId, peaks, duration, beats, downbeatOffset = 0, onSeek, onContainerRef }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const playheadPct = useRef(0);
  const animFrameRef = useRef<number>(0);
  const isDraggingBeat = useRef(false);

  // Find nearest BAR beat (every 4th beat = "1" beat) to an x position
  const findNearestBarBeat = useCallback(
    (clientX: number): number | null => {
      if (!beats || beats.length === 0 || !containerRef.current || duration <= 0) return null;
      const rect = containerRef.current.getBoundingClientRect();
      const relX = clientX - rect.left;
      const w = rect.width;

      let closest: number | null = null;
      let minDist = BEAT_SNAP_PX;
      for (let i = downbeatOffset; i < beats.length; i += 4) {
        const beatTime = beats[i] ?? 0;
        const beatX = (beatTime / duration) * w;
        const dist = Math.abs(beatX - relX);
        if (dist < minDist) {
          minDist = dist;
          closest = beatTime;
        }
      }
      return closest;
    },
    [beats, duration]
  );

  // Draw the static waveform + beat grid
  const drawStatic = useCallback((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const mid = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Draw beat grid lines (behind waveform)
    if (beats && beats.length > 0 && duration > 0) {
      ctx.save();
      for (let i = 0; i < beats.length; i++) {
        const x = ((beats[i] ?? 0) / duration) * w;
        const isBar = (i - downbeatOffset + 400) % 4 === 0; // +400 to keep modulo positive
        ctx.strokeStyle = isBar ? "rgba(251, 191, 36, 0.25)" : "rgba(251, 191, 36, 0.10)";
        ctx.lineWidth = isBar ? 1.5 : 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Draw waveform bars
    if (peaks.length === 0) return;
    const barWidth = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const peak = peaks[i] ?? 0;
      const barH = Math.max(1, peak * (h * 0.85));
      const x = i * barWidth;
      ctx.fillStyle = "rgba(161, 161, 170, 0.45)";
      ctx.fillRect(x, mid - barH / 2, Math.max(barWidth - 0.5, 0.5), barH);
    }
  }, [peaks, beats, duration, downbeatOffset]);

  // Draw the dynamic overlay (played region + playhead)
  const drawOverlay = useCallback((canvas: HTMLCanvasElement, pct: number) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const x = pct * w;

    if (x > 0) {
      ctx.fillStyle = "rgba(99, 102, 241, 0.12)";
      ctx.fillRect(0, 0, x, h);
    }

    ctx.strokeStyle = "rgba(129, 140, 248, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(99, 102, 241, 0.6)";
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    ctx.restore();
  }, []);

  // Initial draw + resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawStatic(canvas);
    const observer = new ResizeObserver(() => drawStatic(canvas));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawStatic]);

  // Overlay canvas setup
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const syncSize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = overlay.getBoundingClientRect();
      overlay.width = rect.width * dpr;
      overlay.height = rect.height * dpr;
    };
    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, []);

  // Playback ticks
  useEffect(() => {
    const handler = (e: Event) => {
      const { trackId: tid, position } = (e as CustomEvent).detail;
      if (tid !== trackId || duration <= 0) return;
      playheadPct.current = position / duration;
      if (!animFrameRef.current) {
        animFrameRef.current = requestAnimationFrame(() => {
          const overlay = overlayRef.current;
          if (overlay) drawOverlay(overlay, playheadPct.current);
          animFrameRef.current = 0;
        });
      }
    };
    window.addEventListener("dj:playbackTick", handler);
    return () => {
      window.removeEventListener("dj:playbackTick", handler);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [trackId, duration, drawOverlay]);

  // Mouse handlers for beat dragging + click-to-seek
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const beatTime = findNearestBarBeat(e.clientX);
      if (beatTime !== null) {
        isDraggingBeat.current = true;
        const rect = containerRef.current!.getBoundingClientRect();
        const beatX = rect.left + (beatTime / duration) * rect.width;
        const beatY = rect.top + rect.height / 2;
        useBeatDragStore.getState().startDrag({
          sourceTrackId: trackId,
          sourceBeatTime: beatTime,
          startX: beatX,
          startY: beatY,
        });
        e.preventDefault();
      }
    },
    [trackId, duration, findNearestBarBeat]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isDraggingBeat.current) {
        isDraggingBeat.current = false;
        // Check if we dropped on this waveform's beat
        const drag = useBeatDragStore.getState().endDrag();
        if (drag && drag.sourceTrackId !== trackId) {
          const targetBeat = findNearestBarBeat(e.clientX);
          if (targetBeat !== null) {
            useConnectionStore.getState().addConnection({
              sourceTrackId: drag.sourceTrackId,
              sourceBeatTime: drag.sourceBeatTime,
              targetTrackId: trackId,
              targetBeatTime: targetBeat,
            });
          }
        }
        return;
      }
      // Normal click-to-seek
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      onSeek(pct * duration);
    },
    [trackId, duration, onSeek, findNearestBarBeat]
  );

  // Cursor changes near beats
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;

      // Update drag position globally
      const drag = useBeatDragStore.getState().drag;
      if (drag) {
        useBeatDragStore.getState().updateDrag(e.clientX, e.clientY);
        return;
      }

      const nearBeat = findNearestBarBeat(e.clientX);
      container.style.cursor = nearBeat !== null ? "grab" : "pointer";
    },
    [findNearestBarBeat]
  );

  return (
    <div
      ref={(el) => {
        (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        onContainerRef?.(el);
      }}
      className="relative flex-1 h-14 bg-zinc-800/40 rounded-md overflow-hidden cursor-pointer"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={overlayRef} className="absolute inset-0 w-full h-full" />
      {peaks.length === 0 && (
        <span className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-600">
          No waveform data
        </span>
      )}
    </div>
  );
}
