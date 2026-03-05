import { useRef, useEffect, useCallback } from "react";

interface ZoomedWaveformProps {
  trackId: string;
  peaks: number[];
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

  // Interpolate peak value at a fractional index
  const peakAt = (t: number): number => {
    if (peaks.length === 0 || duration <= 0) return 0;
    const idx = (t / duration) * peaks.length;
    const i0 = Math.floor(idx);
    const i1 = Math.ceil(idx);
    if (i0 < 0) return peaks[0] ?? 0;
    if (i1 >= peaks.length) return peaks[peaks.length - 1] ?? 0;
    if (i0 === i1) return peaks[i0] ?? 0;
    const frac = idx - i0;
    return ((peaks[i0] ?? 0) * (1 - frac)) + ((peaks[i1] ?? 0) * frac);
  };

  const draw = useCallback(
    (canvas: HTMLCanvasElement, position: number) => {
      const ctx = canvas.getContext("2d");
      if (!ctx || duration <= 0 || peaks.length === 0) return;

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
      const timeEnd = position + halfWindow;

      // Draw beat grid lines
      if (beats && beats.length > 0) {
        for (let i = 0; i < beats.length; i++) {
          const bt = beats[i] ?? 0;
          if (bt < timeStart - 1 || bt > timeEnd + 1) continue;
          const x = timeToX(bt, timeStart, w);
          const isBar = (i - downbeatOffset + 400) % 4 === 0;
          ctx.strokeStyle = isBar
            ? "rgba(251, 191, 36, 0.3)"
            : "rgba(251, 191, 36, 0.1)";
          ctx.lineWidth = isBar ? 1.5 : 0.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      }

      // Draw smooth waveform as filled polygon
      // Sample one point per pixel for smooth rendering
      const numPoints = Math.ceil(w);
      const step = zoom / numPoints; // seconds per pixel

      // Upper half
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let i = 0; i <= numPoints; i++) {
        const t = timeStart + i * step;
        const peak = (t >= 0 && t <= duration) ? peakAt(t) : 0;
        const amp = peak * (h * 0.42);
        ctx.lineTo(i, mid - amp);
      }
      // Lower half (mirror, backwards)
      for (let i = numPoints; i >= 0; i--) {
        const t = timeStart + i * step;
        const peak = (t >= 0 && t <= duration) ? peakAt(t) : 0;
        const amp = peak * (h * 0.42);
        ctx.lineTo(i, mid + amp);
      }
      ctx.closePath();

      // Split color: played (left of center) vs unplayed (right of center)
      const centerX = w / 2;

      // Clip and fill played portion
      ctx.save();
      ctx.clip();
      ctx.fillStyle = "rgba(99, 102, 241, 0.4)";
      ctx.fillRect(0, 0, centerX, h);
      ctx.fillStyle = "rgba(161, 161, 170, 0.4)";
      ctx.fillRect(centerX, 0, w - centerX, h);
      ctx.restore();

      // Waveform outline
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let i = 0; i <= numPoints; i++) {
        const t = timeStart + i * step;
        const peak = (t >= 0 && t <= duration) ? peakAt(t) : 0;
        const amp = peak * (h * 0.42);
        ctx.lineTo(i, mid - amp);
      }
      ctx.strokeStyle = "rgba(161, 161, 170, 0.25)";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let i = 0; i <= numPoints; i++) {
        const t = timeStart + i * step;
        const peak = (t >= 0 && t <= duration) ? peakAt(t) : 0;
        const amp = peak * (h * 0.42);
        ctx.lineTo(i, mid + amp);
      }
      ctx.stroke();

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

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-14 rounded-md bg-zinc-800/30"
    />
  );
}
