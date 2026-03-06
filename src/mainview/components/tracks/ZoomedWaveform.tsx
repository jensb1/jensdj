import { useRef, useEffect, useCallback } from "react";
import type { Peaks3Band, CuePoint } from "../../../shared/types.ts";
import { debugLog, debugLogThrottled } from "../../lib/debugLog.ts";

interface ZoomedWaveformProps {
  trackId: string;
  peaks: Peaks3Band;
  duration: number;
  beats?: number[];
  downbeatOffset?: number;
  zoom: number; // seconds visible in viewport
  isPlaying?: boolean;
  lockedPosition?: number | null;
  onLockedPositionChange?: (pos: number) => void;
  onHoverInfoChange?: (info: string | null) => void;
  cues?: CuePoint[];
}

export function ZoomedWaveform({
  trackId, peaks, duration, beats, downbeatOffset = 0, zoom,
  isPlaying = false, lockedPosition, onLockedPositionChange, onHoverInfoChange, cues,
}: ZoomedWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const drawTimeoutRef = useRef<number>(0);
  const playbackPosition = useRef(0);
  const viewPosition = useRef(0);
  const loopRegion = useRef<{ start: number; end: number } | null>(null);

  const isLocked = lockedPosition != null;

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
    (canvas: HTMLCanvasElement, centerPos: number, playPos?: number) => {
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
      const timeStart = centerPos - halfWindow;

      // Draw 3-band stacked waveform
      const numPoints = Math.ceil(w);
      const step = zoom / numPoints;
      const centerX = w / 2;
      const scale = h * 0.42;

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

      // Draw beat grid lines
      if (beats && beats.length > 0) {
        let lastLabelX = -Infinity;
        for (let i = 0; i < beats.length; i++) {
          const bt = beats[i] ?? 0;
          if (bt < timeStart - 1 || bt > timeStart + zoom + 1) continue;
          const x = timeToX(bt, timeStart, w);
          const relativeIndex = i - downbeatOffset;
          if (relativeIndex < 0) continue;
          const beatInBar = ((relativeIndex % 4) + 4) % 4;
          const barNumber = Math.floor(relativeIndex / 4) + 1;
          const beatNumber = beatInBar + 1;
          const isBarStart = beatInBar === 0;

          ctx.strokeStyle = isBarStart
            ? "rgba(236, 72, 153, 0.85)"
            : "rgba(244, 114, 182, 0.35)";
          ctx.lineWidth = isBarStart ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();

          if (x < 10 || x > w - 10 || x - lastLabelX < 24) continue;

          ctx.font = `${isBarStart ? "bold " : ""}9px monospace`;
          ctx.fillStyle = isBarStart
            ? "rgba(253, 164, 175, 0.95)"
            : "rgba(253, 164, 175, 0.75)";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(`${barNumber}.${beatNumber}`, x, 2);
          lastLabelX = x;
        }
      }

      // Draw active loop region
      const loop = loopRegion.current;
      if (loop) {
        const lx1 = timeToX(loop.start, timeStart, w);
        const lx2 = timeToX(loop.end, timeStart, w);
        const clampL = Math.max(0, Math.min(w, lx1));
        const clampR = Math.max(0, Math.min(w, lx2));
        if (clampR > clampL) {
          ctx.fillStyle = "rgba(249, 115, 22, 0.12)";
          ctx.fillRect(clampL, 0, clampR - clampL, h);
          // Loop boundaries
          ctx.strokeStyle = "rgba(249, 115, 22, 0.7)";
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 3]);
          if (lx1 >= 0 && lx1 <= w) {
            ctx.beginPath(); ctx.moveTo(lx1, 0); ctx.lineTo(lx1, h); ctx.stroke();
          }
          if (lx2 >= 0 && lx2 <= w) {
            ctx.beginPath(); ctx.moveTo(lx2, 0); ctx.lineTo(lx2, h); ctx.stroke();
          }
          ctx.setLineDash([]);
        }
      }

      // Draw cue markers
      if (cues && cues.length > 0) {
        for (const cue of cues) {
          if (cue.time < timeStart - 1 || cue.time > timeStart + zoom + 1) continue;
          const cx = timeToX(cue.time, timeStart, w);
          // Vertical line
          ctx.strokeStyle = cue.color;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.moveTo(cx, 0);
          ctx.lineTo(cx, h);
          ctx.stroke();
          ctx.globalAlpha = 1;
          // Label badge
          ctx.fillStyle = cue.color;
          ctx.fillRect(cx, 0, 14, 12);
          ctx.fillStyle = "#000";
          ctx.font = "bold 9px monospace";
          ctx.fillText(cue.label, cx + 3, 10);
        }
      }

      // When locked, draw the real playback position as a moving red line
      if (playPos !== undefined && isLocked) {
        const playX = timeToX(playPos, timeStart, w);
        if (playX >= 0 && playX <= w) {
          ctx.strokeStyle = "rgba(239, 68, 68, 0.8)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(playX, 0);
          ctx.lineTo(playX, h);
          ctx.stroke();
        }
      }

      // Center line — amber when locked, red when playing, white when paused
      const centerColor = isLocked
        ? "rgba(245, 158, 11, 0.95)"
        : isPlaying
          ? "rgba(239, 68, 68, 0.95)"
          : "rgba(255, 255, 255, 0.9)";
      const shadowColor = isLocked
        ? "rgba(245, 158, 11, 0.6)"
        : isPlaying
          ? "rgba(239, 68, 68, 0.6)"
          : "rgba(255, 255, 255, 0.5)";
      ctx.strokeStyle = centerColor;
      ctx.lineWidth = 2;
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(centerX, h);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // "LOCKED" indicator
      if (isLocked) {
        ctx.fillStyle = "rgba(245, 158, 11, 0.7)";
        ctx.font = "bold 9px monospace";
        ctx.fillText("LOCKED", 4, 10);
      }
    },
    [peaks, duration, beats, downbeatOffset, zoom, isPlaying, isLocked, cues]
  );

  // Redraw helper
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    draw(canvas, viewPosition.current, playbackPosition.current);
  }, [draw]);

  const flushWaveformDraw = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    if (drawTimeoutRef.current) {
      clearTimeout(drawTimeoutRef.current);
      drawTimeoutRef.current = 0;
    }
    debugLogThrottled(`zoomedWaveform.draw:${trackId}`, 1000, "zoomedWaveform.drawFrame", {
      trackId,
      isPlaying,
      isLocked,
      playbackPosition: Number(playbackPosition.current.toFixed(3)),
      viewPosition: Number(viewPosition.current.toFixed(3)),
    });
    redraw();
  }, [trackId, isPlaying, isLocked, redraw]);

  // Resize
  useEffect(() => {
    redraw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  // Update view position when lock changes
  useEffect(() => {
    debugLog("zoomedWaveform.lockState", {
      trackId,
      isPlaying,
      lockedPosition,
      playbackPosition: Number(playbackPosition.current.toFixed(3)),
      viewPosition: Number(viewPosition.current.toFixed(3)),
    });
    if (lockedPosition != null) {
      viewPosition.current = lockedPosition;
    } else {
      // Unlocked — snap back to playback position
      viewPosition.current = playbackPosition.current;
    }
    redraw();
  }, [lockedPosition, redraw]);

  useEffect(() => {
    debugLog("zoomedWaveform.playStateRedraw", {
      trackId,
      isPlaying,
      isLocked,
      playbackPosition: Number(playbackPosition.current.toFixed(3)),
      viewPosition: Number(viewPosition.current.toFixed(3)),
    });
    flushWaveformDraw();
  }, [trackId, isPlaying, isLocked, flushWaveformDraw]);

  // Listen for playback ticks
  useEffect(() => {
    const handler = (e: Event) => {
      const { trackId: tid, position, loopStart, loopEnd } = (e as CustomEvent).detail;
      if (tid !== trackId) return;
      playbackPosition.current = position;
      loopRegion.current = (loopStart != null && loopEnd != null)
        ? { start: loopStart, end: loopEnd }
        : null;

      // Only follow playback if not locked
      if (!isLocked) {
        viewPosition.current = position;
      }

      debugLogThrottled(`zoomedWaveform.tick:${trackId}`, 1000, "zoomedWaveform.tick", {
        trackId,
        isPlaying,
        isLocked,
        position: Number(position.toFixed(3)),
        viewPosition: Number(viewPosition.current.toFixed(3)),
        lockedPosition,
        loopStart: loopStart != null ? Number(loopStart.toFixed(3)) : null,
        loopEnd: loopEnd != null ? Number(loopEnd.toFixed(3)) : null,
      });

      if (!animFrameRef.current) {
        animFrameRef.current = requestAnimationFrame(() => {
          flushWaveformDraw();
        });
        drawTimeoutRef.current = window.setTimeout(() => {
          flushWaveformDraw();
        }, 34);
      }
    };
    window.addEventListener("dj:playbackTick", handler);
    return () => {
      window.removeEventListener("dj:playbackTick", handler);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (drawTimeoutRef.current) clearTimeout(drawTimeoutRef.current);
    };
  }, [trackId, flushWaveformDraw, isLocked, isPlaying, lockedPosition]);

  // Drag to scrub — works when paused OR locked
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartPos = useRef(0);

  const canDrag = !isPlaying || isLocked;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canDrag) return;
      isDragging.current = true;
      debugLog("zoomedWaveform.mouseDown", {
        trackId,
        canDrag,
        isLocked,
        isPlaying,
        viewPosition: Number(viewPosition.current.toFixed(3)),
      });
      dragStartX.current = e.clientX;
      dragStartPos.current = viewPosition.current;
      e.currentTarget.style.cursor = "grabbing";
    },
    [canDrag]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();

      if (isDragging.current && canDrag) {
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

        viewPosition.current = newPos;

        if (isLocked) {
          onLockedPositionChange?.(newPos);
        } else {
          window.djRpc?.request?.seek?.({ trackId, seconds: newPos });
        }

        debugLogThrottled(`zoomedWaveform.drag:${trackId}`, 250, "zoomedWaveform.drag", {
          trackId,
          newPos: Number(newPos.toFixed(3)),
          isLocked,
          isPlaying,
        });

        const canvas = canvasRef.current;
        if (canvas) draw(canvas, newPos, playbackPosition.current);
      }

      // Hover info
      const relX = e.clientX - rect.left;
      const halfWindow = zoom / 2;
      const timeStart = viewPosition.current - halfWindow;
      const hoverTime = timeStart + (relX / rect.width) * zoom;
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
      onHoverInfoChange?.(`t=${hoverTime.toFixed(3)}s | ${beatNum} ${diff}`.trim());
    },
    [zoom, beats, duration, trackId, draw, canDrag, isLocked, onLockedPositionChange, onHoverInfoChange]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      isDragging.current = false;
      e.currentTarget.style.cursor = canDrag ? "grab" : "default";
    },
    [canDrag]
  );

  const handleMouseLeave = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    isDragging.current = false;
    e.currentTarget.style.cursor = canDrag ? "grab" : "default";
    onHoverInfoChange?.(null);
  }, [canDrag, onHoverInfoChange]);

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        className={`w-full h-28 rounded-md bg-zinc-800/30 ${canDrag ? "cursor-grab" : ""}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
    </div>
  );
}
