import { useRef, useEffect, useCallback, useState } from "react";
import type { Peaks3Band } from "../../../shared/types.ts";

interface ZoomedWaveformProps {
  trackId: string;
  peaks: Peaks3Band;
  duration: number;
  beats?: number[];
  downbeatOffset?: number;
  zoom: number; // seconds visible in viewport
}

export function ZoomedWaveform({ trackId, peaks, duration, beats, downbeatOffset = 0, zoom }: ZoomedWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const currentPosition = useRef(0);

  // Convert a time (seconds) to canvas x coordinate
  const timeToX = (time: number, timeStart: number, w: number) =>
    ((time - timeStart) / zoom) * w;

  // Interpolate peak value at a fractional index for a given band
  const peakAt = (band: number[], t: number): number => {
    if (band.length === 0 || duration <= 0) return 0;
    const idx = (t / duration) * band.length;
    const i0 = Math.floor(idx);
    const i1 = Math.ceil(idx);
    if (i0 < 0) return band[0] ?? 0;
    if (i1 >= band.length) return band[band.length - 1] ?? 0;
    if (i0 === i1) return band[i0] ?? 0;
    const frac = idx - i0;
    return ((band[i0] ?? 0) * (1 - frac)) + ((band[i1] ?? 0) * frac);
  };

  const draw = useCallback(
    (canvas: HTMLCanvasElement, position: number) => {
      const ctx = canvas.getContext("2d");
      if (!ctx || duration <= 0 || peaks.low.length === 0) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const cw = Math.round(rect.width * dpr);
      const ch = Math.round(rect.height * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const w = rect.width;
      const h = rect.height;
      const mid = h / 2;

      ctx.clearRect(0, 0, w, h);

      const halfWindow = zoom / 2;
      const timeStart = position - halfWindow;

      // Draw 3-band stacked waveform (Rekordbox-style)
      const numPoints = Math.ceil(w);
      const step = zoom / numPoints;
      const centerX = w / 2;
      const scale = h * 0.42;

      // Per-band normalization for visual balance
      let maxLo = 0, maxMi = 0, maxHi = 0;
      for (let j = 0; j < peaks.low.length; j++) {
        if ((peaks.low[j] ?? 0) > maxLo) maxLo = peaks.low[j]!;
        if ((peaks.mid[j] ?? 0) > maxMi) maxMi = peaks.mid[j]!;
        if ((peaks.high[j] ?? 0) > maxHi) maxHi = peaks.high[j]!;
      }
      if (maxLo < 0.01) maxLo = 1;
      if (maxMi < 0.01) maxMi = 1;
      if (maxHi < 0.01) maxHi = 1;

      const normPeak = (band: number[], maxB: number, t: number) =>
        peakAt(band, t) / maxB;

      // Draw blue first (outermost), orange on top, white on top (innermost)
      // Each layer uses max(own, inner) so blue extends beyond orange at kicks
      const layers = [
        { env: (t: number) => Math.max(normPeak(peaks.low, maxLo, t), normPeak(peaks.mid, maxMi, t), normPeak(peaks.high, maxHi, t)),
          bright: "#2563ff", dim: "#2563ff" },
        { env: (t: number) => Math.max(normPeak(peaks.mid, maxMi, t), normPeak(peaks.high, maxHi, t)),
          bright: "#ff9500", dim: "#ff9500" },
        { env: (t: number) => normPeak(peaks.high, maxHi, t),
          bright: "#e8e8ff", dim: "#e8e8ff" },
      ];

      for (const { env, bright, dim } of layers) {
        ctx.beginPath();
        ctx.moveTo(0, mid);
        for (let i = 0; i <= numPoints; i++) {
          const t = timeStart + i * step;
          const amp = (t >= 0 && t <= duration) ? env(t) * scale : 0;
          ctx.lineTo(i, mid - amp);
        }
        for (let i = numPoints; i >= 0; i--) {
          const t = timeStart + i * step;
          const amp = (t >= 0 && t <= duration) ? env(t) * scale : 0;
          ctx.lineTo(i, mid + amp);
        }
        ctx.closePath();

        ctx.save();
        ctx.clip();
        ctx.fillStyle = bright;
        ctx.fillRect(0, 0, centerX, h);
        ctx.fillStyle = dim;
        ctx.fillRect(centerX, 0, w - centerX, h);
        ctx.restore();
      }

      // Draw beat grid lines (on top of waveform)
      if (beats && beats.length > 0) {
        for (let i = 0; i < beats.length; i++) {
          const bt = beats[i] ?? 0;
          if (bt < timeStart - 1 || bt > timeStart + zoom + 1) continue;
          const x = timeToX(bt, timeStart, w);
          const isBar = (i - downbeatOffset + 400) % 4 === 0;
          if (!isBar) continue; // only draw downbeat markers
          ctx.strokeStyle = "rgba(236, 72, 153, 0.8)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      }

      // Center playhead line
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = 2;
      ctx.shadowColor = "rgba(255, 255, 255, 0.5)";
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(centerX, h);
      ctx.stroke();
      ctx.shadowBlur = 0;
    },
    [peaks, duration, beats, downbeatOffset, zoom]
  );

  // Resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    draw(canvas, currentPosition.current);
    const observer = new ResizeObserver(() => {
      draw(canvas, currentPosition.current);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  // Listen for playback ticks
  useEffect(() => {
    const handler = (e: Event) => {
      const { trackId: tid, position } = (e as CustomEvent).detail;
      if (tid !== trackId) return;
      currentPosition.current = position;

      if (!animFrameRef.current) {
        animFrameRef.current = requestAnimationFrame(() => {
          const canvas = canvasRef.current;
          if (canvas) draw(canvas, currentPosition.current);
          animFrameRef.current = 0;
        });
      }
    };
    window.addEventListener("dj:playbackTick", handler);
    return () => {
      window.removeEventListener("dj:playbackTick", handler);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [trackId, draw]);

  // Mouse hover → show time + nearest beat; drag → scrub position
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartPos = useRef(0);

  const xToTime = useCallback(
    (clientX: number, rect: DOMRect) => {
      const relX = clientX - rect.left;
      const halfWindow = zoom / 2;
      const timeStart = currentPosition.current - halfWindow;
      return timeStart + (relX / rect.width) * zoom;
    },
    [zoom]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      isDragging.current = true;
      dragStartX.current = e.clientX;
      dragStartPos.current = currentPosition.current;
      e.currentTarget.style.cursor = "grabbing";
    },
    []
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();

      if (isDragging.current) {
        // Drag: move position based on horizontal delta, snap to nearest beat
        const dx = e.clientX - dragStartX.current;
        const secondsPerPx = zoom / rect.width;
        let newPos = Math.max(0, Math.min(duration, dragStartPos.current - dx * secondsPerPx));

        // Snap to nearest beat
        if (beats && beats.length > 0) {
          let nearest = beats[0] ?? 0;
          let minDist = Infinity;
          for (let i = 0; i < beats.length; i++) {
            const d = Math.abs((beats[i] ?? 0) - newPos);
            if (d < minDist) { minDist = d; nearest = beats[i] ?? 0; }
          }
          newPos = nearest;
        }

        currentPosition.current = newPos;
        window.djRpc?.request?.seek?.({ trackId, seconds: newPos });
        const canvas = canvasRef.current;
        if (canvas) draw(canvas, newPos);
      }

      // Hover info
      const hoverTime = xToTime(e.clientX, rect);
      let nearestBeat = 0;
      let nearestIdx = -1;
      let minDist = Infinity;
      if (beats) {
        for (let i = 0; i < beats.length; i++) {
          const d = Math.abs((beats[i] ?? 0) - hoverTime);
          if (d < minDist) { minDist = d; nearestBeat = beats[i] ?? 0; nearestIdx = i; }
        }
      }

      const beatNum = nearestIdx >= 0 ? `beat[${nearestIdx}]=${nearestBeat.toFixed(3)}s` : "no beats";
      const diff = nearestIdx >= 0 ? `Δ${((hoverTime - nearestBeat) * 1000).toFixed(0)}ms` : "";
      setHoverInfo(`t=${hoverTime.toFixed(3)}s | ${beatNum} ${diff} | pos=${currentPosition.current.toFixed(3)}s`);
    },
    [zoom, beats, duration, trackId, draw, xToTime]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      isDragging.current = false;
      e.currentTarget.style.cursor = "grab";
    },
    []
  );

  const handleMouseLeave = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    isDragging.current = false;
    e.currentTarget.style.cursor = "grab";
    setHoverInfo(null);
  }, []);

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        className="w-full h-28 rounded-md bg-zinc-800/30 cursor-grab"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
      {hoverInfo && (
        <div className="absolute top-0 left-0 right-0 bg-black/70 text-[9px] font-mono text-zinc-300 px-1.5 py-0.5 pointer-events-none">
          {hoverInfo}
        </div>
      )}
    </div>
  );
}
