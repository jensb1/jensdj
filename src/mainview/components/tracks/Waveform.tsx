import { useRef, useEffect, useCallback } from "react";
import type { Peaks3Band, CuePoint } from "../../../shared/types.ts";
import { CueMarkers } from "./CueMarkers.tsx";
import { debugLog, debugLogThrottled } from "../../lib/debugLog.ts";

interface WaveformProps {
  trackId: string;
  peaks: Peaks3Band;
  duration: number;
  beats?: number[];
  downbeatOffset?: number;
  isPlaying?: boolean;
  position?: number;
  previewPosition?: number | null;
  cues?: CuePoint[];
  onSeek: (seconds: number) => void;
  onPreview?: (seconds: number | null) => void;
  onPlayFromPreview?: (seconds: number) => void;
  onContainerRef?: (el: HTMLDivElement | null) => void;
}

export function Waveform({ trackId, peaks, duration, beats, downbeatOffset = 0, isPlaying = false, position = 0, previewPosition, cues, onSeek, onPreview, onPlayFromPreview, onContainerRef }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const playheadPct = useRef(0);
  const animFrameRef = useRef<number>(0);
  const drawTimeoutRef = useRef<number>(0);

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

    ctx.clearRect(0, 0, w, h);

    // Draw 3-band stacked waveform (Rekordbox-style, half-height from bottom)
    // Each band normalized independently for visual balance
    const numPoints = peaks.low.length;
    if (numPoints === 0) return;
    const barWidth = w / numPoints;
    const bw = Math.max(barWidth - 0.5, 0.5);

    // Per-band normalization
    let maxLo = 0, maxMi = 0, maxHi = 0;
    for (let i = 0; i < numPoints; i++) {
      if ((peaks.low[i] ?? 0) > maxLo) maxLo = peaks.low[i]!;
      if ((peaks.mid[i] ?? 0) > maxMi) maxMi = peaks.mid[i]!;
      if ((peaks.high[i] ?? 0) > maxHi) maxHi = peaks.high[i]!;
    }
    if (maxLo < 0.01) maxLo = 1;
    if (maxMi < 0.01) maxMi = 1;
    if (maxHi < 0.01) maxHi = 1;

    const scale = h * 0.9;
    const baseline = h;

    for (let i = 0; i < numPoints; i++) {
      const lo = (peaks.low[i] ?? 0) / maxLo;
      const mi = (peaks.mid[i] ?? 0) / maxMi;
      const hi = (peaks.high[i] ?? 0) / maxHi;
      const total = Math.max(lo, mi, hi);
      if (total < 0.01) continue;
      const x = i * barWidth;

      // Draw blue at full height, orange on top, white on top
      // Visual result: blue at outer edges, orange in middle, white at base
      const barH = total * scale;

      // Blue (low) — drawn first at full bar height
      ctx.fillStyle = "#2563ff";
      ctx.fillRect(x, baseline - barH, bw, barH);

      // Orange (mid) — height proportional to mid, paints over blue
      const miH = Math.max(mi, hi) * scale;
      if (miH > 0.5) {
        ctx.fillStyle = "#ff9500";
        ctx.fillRect(x, baseline - miH, bw, miH);
      }

      // White (high) — height proportional to high only
      const hiH = hi * scale;
      if (hiH > 0.5) {
        ctx.fillStyle = "#e8e8ff";
        ctx.fillRect(x, baseline - hiH, bw, hiH);
      }
    }
  }, [peaks, duration]);

  // Draw the dynamic overlay (played region + playhead + preview cursor + loop)
  const previewPctRef = useRef<number | null>(null);
  const loopPctRef = useRef<{ start: number; end: number } | null>(null);

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

    // Playhead: RED when playing, indigo when paused
    ctx.strokeStyle = isPlaying ? "rgba(239, 68, 68, 0.95)" : "rgba(129, 140, 248, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = isPlaying ? "rgba(239, 68, 68, 0.6)" : "rgba(99, 102, 241, 0.6)";
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Loop region highlight
    const lp = loopPctRef.current;
    if (lp) {
      const lx1 = lp.start * w;
      const lx2 = lp.end * w;
      ctx.fillStyle = "rgba(249, 115, 22, 0.15)";
      ctx.fillRect(lx1, 0, lx2 - lx1, h);
      ctx.strokeStyle = "rgba(249, 115, 22, 0.6)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.beginPath(); ctx.moveTo(lx1, 0); ctx.lineTo(lx1, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx2, 0); ctx.lineTo(lx2, h); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Amber preview cursor
    const pvPct = previewPctRef.current;
    if (pvPct !== null) {
      const px = pvPct * w;
      ctx.strokeStyle = "rgba(245, 158, 11, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.shadowColor = "rgba(245, 158, 11, 0.5)";
      ctx.shadowBlur = 3;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }, [isPlaying]);

  const flushOverlayDraw = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    if (drawTimeoutRef.current) {
      clearTimeout(drawTimeoutRef.current);
      drawTimeoutRef.current = 0;
    }
    const overlay = overlayRef.current;
    if (!overlay) return;
    debugLogThrottled(`waveform.draw:${trackId}`, 1000, "waveform.drawFrame", {
      trackId,
      isPlaying,
      playheadPct: Number(playheadPct.current.toFixed(4)),
      previewPosition,
    });
    drawOverlay(overlay, playheadPct.current);
  }, [trackId, isPlaying, previewPosition, drawOverlay]);

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

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    debugLog("waveform.playStateRedraw", {
      trackId,
      isPlaying,
      playheadPct: Number(playheadPct.current.toFixed(4)),
      previewPosition,
    });
    flushOverlayDraw();
  }, [trackId, isPlaying, previewPosition, flushOverlayDraw]);

  useEffect(() => {
    if (duration <= 0) return;
    if (isPlaying) return;
    playheadPct.current = position / duration;
    flushOverlayDraw();
  }, [position, duration, isPlaying, flushOverlayDraw]);

  // Playback ticks
  useEffect(() => {
    debugLog("waveform.isPlaying", {
      trackId,
      isPlaying,
      previewPosition,
    });
  }, [trackId, isPlaying, previewPosition]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { trackId: tid, position, loopStart, loopEnd } = (e as CustomEvent).detail;
      if (tid !== trackId || duration <= 0) return;
      playheadPct.current = position / duration;
      loopPctRef.current = (loopStart != null && loopEnd != null)
        ? { start: loopStart / duration, end: loopEnd / duration }
        : null;
      debugLogThrottled(`waveform.tick:${trackId}`, 1000, "waveform.tick", {
        trackId,
        isPlaying,
        position: Number(position.toFixed(3)),
        playheadPct: Number(playheadPct.current.toFixed(4)),
        previewPosition,
        loopStart: loopStart != null ? Number(loopStart.toFixed(3)) : null,
        loopEnd: loopEnd != null ? Number(loopEnd.toFixed(3)) : null,
      });
      if (!animFrameRef.current) {
        animFrameRef.current = requestAnimationFrame(() => {
          flushOverlayDraw();
        });
        drawTimeoutRef.current = window.setTimeout(() => {
          flushOverlayDraw();
        }, 34);
      }
    };
    window.addEventListener("dj:playbackTick", handler);
    return () => {
      window.removeEventListener("dj:playbackTick", handler);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (drawTimeoutRef.current) clearTimeout(drawTimeoutRef.current);
    };
  }, [trackId, duration, flushOverlayDraw, isPlaying, previewPosition]);

  // Update preview from prop
  useEffect(() => {
    if (previewPosition !== null && previewPosition !== undefined && duration > 0) {
      previewPctRef.current = previewPosition / duration;
    } else {
      previewPctRef.current = null;
    }
  }, [previewPosition, duration]);

  // Drag-to-scrub (or preview when playing)
  const isDragging = useRef(false);

  const timeFromX = useCallback(
    (clientX: number): number => {
      const el = containerRef.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      let time = pct * duration;

      // Snap to nearest downbeat (beat "1")
      if (beats && beats.length > 0) {
        let nearest = beats[0] ?? 0;
        let minDist = Infinity;
        for (let i = downbeatOffset; i < beats.length; i += 4) {
          const d = Math.abs((beats[i] ?? 0) - time);
          if (d < minDist) { minDist = d; nearest = beats[i] ?? 0; }
        }
        time = nearest;
      }
      return time;
    },
    [duration, beats, downbeatOffset]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      isDragging.current = true;
      const time = timeFromX(e.clientX);
      if (isPlaying) {
        onPreview?.(time);
      } else {
        onSeek(time);
      }
      const onMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        const t = timeFromX(ev.clientX);
        if (isPlaying) {
          onPreview?.(t);
        } else {
          onSeek(t);
        }
      };
      const onUp = () => {
        isDragging.current = false;
        if (isPlaying) onPreview?.(null);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [timeFromX, isPlaying, onSeek, onPreview]
  );

  const previewPercent = previewPosition != null && duration > 0
    ? Math.max(0, Math.min(100, (previewPosition / duration) * 100))
    : null;

  return (
    <div
      ref={(el) => {
        (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        onContainerRef?.(el);
      }}
      className="relative flex-1 h-7 bg-zinc-800/40 rounded-md cursor-pointer"
      onMouseDown={handleMouseDown}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={overlayRef} className="absolute inset-0 w-full h-full" />
      {previewPosition != null && onPlayFromPreview && (
        <button
          type="button"
          className="absolute -top-5 z-20 rounded bg-amber-400 px-1.5 py-px text-[8px] font-bold text-black shadow"
          style={{
            left: `${previewPercent}%`,
            transform: "translateX(-50%)",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onPlayFromPreview(previewPosition);
          }}
        >
          Play here
        </button>
      )}
      {cues && cues.length > 0 && (
        <CueMarkers
          cues={cues}
          duration={duration}
          containerWidth={containerRef.current?.getBoundingClientRect().width ?? 0}
          trackId={trackId}
        />
      )}
      {peaks.low.length === 0 && (
        <span className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-600">
          No waveform data
        </span>
      )}
    </div>
  );
}
