import { useRef, useEffect, useCallback } from "react";
import type { Peaks3Band, CuePoint } from "../../../shared/types.ts";
import { debugLog, debugLogThrottled } from "../../lib/debugLog.ts";
import { useCueStore } from "../../stores/cueStore.ts";
import { usePlayerStore } from "../../stores/playerStore.ts";

interface ZoomedWaveformProps {
  trackId: string;
  peaks: Peaks3Band;
  duration: number;
  beats?: number[];
  downbeatOffset?: number;
  zoom: number; // seconds visible in viewport
  isPlaying?: boolean;
  position?: number;
  lockedPosition?: number | null;
  onLockedPositionChange?: (pos: number) => void;
  onUnlock?: () => void;
  onHoverTimeChange?: (time: number | null) => void;
  cues?: CuePoint[];
}

export function ZoomedWaveform({
  trackId, peaks, duration, beats, downbeatOffset = 0, zoom,
  isPlaying = false, position = 0, lockedPosition, onLockedPositionChange, onUnlock, onHoverTimeChange, cues,
}: ZoomedWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const drawTimeoutRef = useRef<number>(0);
  const playbackPosition = useRef(0);
  const viewPosition = useRef(0);
  const loopRegion = useRef<{ start: number; end: number } | null>(null);
  const redrawRef = useRef<() => void>(() => {});
  const draggingCueRef = useRef<string | null>(null);
  const draggingLoopRef = useRef<"start" | "end" | "body" | null>(null);
  const loopDragStartMouse = useRef(0);
  const loopDragStartRegion = useRef<{ start: number; end: number } | null>(null);

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

      // Draw loop regions from cue automations (always visible)
      if (cues) {
        const playerTracks = usePlayerStore.getState().tracks;
        const trackState = playerTracks.get(trackId);
        const bpm = trackState?.track.bpm ?? 120;
        const beatDur = 60 / bpm;
        for (const cue of cues) {
          const loopAuto = cue.automations.find((a) => a.type === "loop");
          if (!loopAuto) continue;
          const loopBeats = loopAuto.endValue > 0 ? loopAuto.endValue : 16;
          const loopStart = cue.time;
          const loopEnd = cue.time + loopBeats * beatDur;
          const lx1 = timeToX(loopStart, timeStart, w);
          const lx2 = timeToX(loopEnd, timeStart, w);
          const clampL = Math.max(0, Math.min(w, lx1));
          const clampR = Math.max(0, Math.min(w, lx2));
          if (clampR <= clampL) continue;

          // Dim preview if not actively looping, bright if C engine loop matches
          const engineLoop = loopRegion.current;
          const isActive = engineLoop && Math.abs(engineLoop.start - loopStart) < 0.1 && Math.abs(engineLoop.end - loopEnd) < 0.1;
          const fillAlpha = isActive ? 0.15 : 0.07;
          const strokeAlpha = isActive ? 0.8 : 0.35;

          ctx.fillStyle = `rgba(249, 115, 22, ${fillAlpha})`;
          ctx.fillRect(clampL, 0, clampR - clampL, h);
          ctx.strokeStyle = `rgba(249, 115, 22, ${strokeAlpha})`;
          ctx.lineWidth = isActive ? 2 : 1;
          ctx.setLineDash(isActive ? [4, 3] : [3, 4]);
          if (lx1 >= 0 && lx1 <= w) {
            ctx.beginPath(); ctx.moveTo(lx1, 0); ctx.lineTo(lx1, h); ctx.stroke();
          }
          if (lx2 >= 0 && lx2 <= w) {
            ctx.beginPath(); ctx.moveTo(lx2, 0); ctx.lineTo(lx2, h); ctx.stroke();
          }
          ctx.setLineDash([]);
          // Bottom bar in cue color
          ctx.fillStyle = cue.color;
          ctx.globalAlpha = isActive ? 0.8 : 0.4;
          ctx.fillRect(clampL, h - 3, clampR - clampL, 3);
          ctx.globalAlpha = 1;
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
          ctx.globalAlpha = cue.active ? 0.8 : 0.3;
          if (!cue.active) ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(cx, 0);
          ctx.lineTo(cx, h);
          ctx.stroke();
          if (!cue.active) ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          // Label badge
          ctx.globalAlpha = cue.active ? 1 : 0.4;
          ctx.fillStyle = cue.color;
          ctx.fillRect(cx, 0, 14, 12);
          ctx.fillStyle = "#000";
          ctx.font = "bold 9px monospace";
          ctx.fillText(cue.label, cx + 3, 10);
          ctx.globalAlpha = 1;
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

      // "LOCKED" indicator drawn via HTML overlay (see below)
    },
    [peaks, duration, beats, downbeatOffset, zoom, isPlaying, isLocked, cues]
  );

  // Redraw helper
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    draw(canvas, viewPosition.current, playbackPosition.current);
  }, [draw]);

  useEffect(() => {
    redrawRef.current = redraw;
  }, [redraw]);

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

  useEffect(() => {
    playbackPosition.current = position;
    if (lockedPosition != null) {
      viewPosition.current = lockedPosition;
    } else if (!isPlaying) {
      viewPosition.current = position;
    }
    redrawRef.current();
  }, [position, lockedPosition, isPlaying]);

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

      // When locked, always schedule a redraw so the play cursor animates smoothly
      if (isLocked) {
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = requestAnimationFrame(() => {
          animFrameRef.current = 0;
          redrawRef.current();
        });
      } else if (!animFrameRef.current) {
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
      // Check if clicking near a cue marker
      if (cues && cues.length > 0) {
        const rect = e.currentTarget.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const halfWindow = zoom / 2;
        const timeStart = viewPosition.current - halfWindow;
        for (const cue of cues) {
          if (cue.time < timeStart || cue.time > timeStart + zoom) continue;
          const cueX = ((cue.time - timeStart) / zoom) * rect.width;
          if (Math.abs(mouseX - cueX) < 8) {
            draggingCueRef.current = cue.id;
            e.currentTarget.style.cursor = "ew-resize";
            return;
          }
        }
      }

      // Check if clicking near loop boundary (from cue automations)
      if (cues) {
        const trackState = usePlayerStore.getState().tracks.get(trackId);
        const bpm = trackState?.track.bpm ?? 120;
        const beatDur = 60 / bpm;
        const rect2 = e.currentTarget.getBoundingClientRect();
        const mouseX2 = e.clientX - rect2.left;
        const halfW = zoom / 2;
        const tStart = viewPosition.current - halfW;
        for (const cue of cues) {
          const loopAuto = cue.automations.find((a) => a.type === "loop");
          if (!loopAuto) continue;
          const loopBeats = loopAuto.endValue > 0 ? loopAuto.endValue : 16;
          const ls = cue.time;
          const le = cue.time + loopBeats * beatDur;
          const loopStartX = ((ls - tStart) / zoom) * rect2.width;
          const loopEndX = ((le - tStart) / zoom) * rect2.width;
          const region = { start: ls, end: le };
          if (Math.abs(mouseX2 - loopStartX) < 8) {
            draggingLoopRef.current = "start";
            loopDragStartMouse.current = e.clientX;
            loopDragStartRegion.current = { ...region };
            e.currentTarget.style.cursor = "ew-resize";
            return;
          }
          if (Math.abs(mouseX2 - loopEndX) < 8) {
            draggingLoopRef.current = "end";
            loopDragStartMouse.current = e.clientX;
            loopDragStartRegion.current = { ...region };
            e.currentTarget.style.cursor = "ew-resize";
            return;
          }
          if (mouseX2 > loopStartX + 8 && mouseX2 < loopEndX - 8) {
            draggingLoopRef.current = "body";
            loopDragStartMouse.current = e.clientX;
            loopDragStartRegion.current = { ...region };
            e.currentTarget.style.cursor = "move";
            return;
          }
        }
      }

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
    [canDrag, cues, zoom]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();

      // Cue marker dragging
      if (draggingCueRef.current) {
        const mouseX = e.clientX - rect.left;
        const halfWindow = zoom / 2;
        const timeStart = viewPosition.current - halfWindow;
        let time = timeStart + (mouseX / rect.width) * zoom;
        time = Math.max(0, Math.min(duration, time));

        if (beats && beats.length > 0) {
          // Snap to nearest downbeat (bar start)
          const downbeats: number[] = [];
          for (let i = downbeatOffset; i < beats.length; i += 4) {
            downbeats.push(beats[i]!);
          }
          if (downbeats.length > 0) {
            let nearest = downbeats[0]!;
            let minDist = Infinity;
            for (const bt of downbeats) {
              const d = Math.abs(bt - time);
              if (d < minDist) { minDist = d; nearest = bt; }
            }
            time = nearest;
          }
        }

        useCueStore.getState().updateCue(draggingCueRef.current, { time });
        return;
      }

      // Loop boundary dragging
      if (draggingLoopRef.current && loopDragStartRegion.current) {
        const mouseX = e.clientX - rect.left;
        const halfWindow = zoom / 2;
        const timeStart = viewPosition.current - halfWindow;
        let time = timeStart + (mouseX / rect.width) * zoom;
        time = Math.max(0, Math.min(duration, time));

        // Snap to nearest downbeat (bar start)
        if (beats && beats.length > 0) {
          const downbeats: number[] = [];
          for (let i = downbeatOffset; i < beats.length; i += 4) {
            downbeats.push(beats[i]!);
          }
          if (downbeats.length > 0) {
            let nearest = downbeats[0]!;
            let minDist = Infinity;
            for (const bt of downbeats) {
              const d = Math.abs(bt - time);
              if (d < minDist) { minDist = d; nearest = bt; }
            }
            time = nearest;
          }
        }

        const orig = loopDragStartRegion.current;
        let newStart = orig.start;
        let newEnd = orig.end;

        if (draggingLoopRef.current === "start") {
          newStart = Math.min(time, newEnd - 0.1);
        } else if (draggingLoopRef.current === "end") {
          newEnd = Math.max(time, newStart + 0.1);
        } else {
          // body: move entire loop, snap to downbeats
          const dx = e.clientX - loopDragStartMouse.current;
          const secondsPerPx = zoom / rect.width;
          const shift = -dx * secondsPerPx;
          const shiftedStart = orig.start + shift;
          if (beats && beats.length > 0) {
            const downbeats: number[] = [];
            for (let i = downbeatOffset; i < beats.length; i += 4) {
              downbeats.push(beats[i]!);
            }
            let nearest = downbeats[0] ?? 0;
            let minDist = Infinity;
            for (const bt of downbeats) {
              const d = Math.abs(bt - shiftedStart);
              if (d < minDist) { minDist = d; nearest = bt; }
            }
            const snapShift = nearest - orig.start;
            newStart = orig.start + snapShift;
            newEnd = orig.end + snapShift;
          } else {
            newStart = shiftedStart;
            newEnd = orig.end + shift;
          }
        }

        newStart = Math.max(0, newStart);
        newEnd = Math.min(duration, newEnd);
        if (newEnd > newStart + 0.05) {
          loopRegion.current = { start: newStart, end: newEnd };

          // Find the cue that owns this loop and update it through the store
          const allCues = useCueStore.getState().cues;
          let ownerCueId: string | null = null;
          let loopAutoId: string | null = null;
          for (const [, cue] of allCues) {
            if (cue.trackId !== trackId) continue;
            const loopA = cue.automations.find((a) => a.type === "loop");
            if (!loopA) continue;
            // Match: cue time is near original loop start
            if (Math.abs(cue.time - loopDragStartRegion.current!.start) < 0.1 ||
                Math.abs(cue.time - newStart) < 0.1) {
              ownerCueId = cue.id;
              loopAutoId = loopA.id;
              break;
            }
          }

          if (ownerCueId && loopAutoId) {
            const trackState = usePlayerStore.getState().tracks.get(trackId);
            const bpm = trackState?.track.bpm ?? 120;
            const beatDuration = 60 / bpm;
            // Snap to full bars (4 beats) when dragging
            const rawBeats = (newEnd - newStart) / beatDuration;
            const newLoopBeats = Math.max(4, Math.round(rawBeats / 4) * 4);

            if (draggingLoopRef.current === "body" || draggingLoopRef.current === "start") {
              // Moving start or body — update cue time
              useCueStore.getState().updateCue(ownerCueId, { time: newStart });
            }
            // Update loop length in beats
            useCueStore.getState().updateAutomation(ownerCueId, loopAutoId, { endValue: Math.max(1, newLoopBeats) });
          } else {
            // No owning cue found — just update C engine directly
            window.djRpc?.request?.setLoop?.({ trackId, startSec: newStart, endSec: newEnd });
          }

          redrawRef.current();
        }
        return;
      }

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
      onHoverTimeChange?.(Math.max(0, Math.min(duration, hoverTime)));

      // Proximity cursor (cues + loop boundaries)
      if (!isDragging.current && !draggingLoopRef.current) {
        let specialCursor: string | null = null;

        // Loop boundary proximity (from cue automations)
        if (cues) {
          const ts = usePlayerStore.getState().tracks.get(trackId);
          const bpmH = ts?.track.bpm ?? 120;
          const bdH = 60 / bpmH;
          for (const cue of cues) {
            const la = cue.automations.find((a) => a.type === "loop");
            if (!la) continue;
            const lb = la.endValue > 0 ? la.endValue : 16;
            const lsx = ((cue.time - timeStart) / zoom) * rect.width;
            const lex = (((cue.time + lb * bdH) - timeStart) / zoom) * rect.width;
            if (Math.abs(relX - lsx) < 8 || Math.abs(relX - lex) < 8) {
              specialCursor = "ew-resize";
              break;
            } else if (relX > lsx + 8 && relX < lex - 8) {
              specialCursor = "move";
              break;
            }
          }
        }

        // Cue proximity
        if (!specialCursor && cues && cues.length > 0) {
          for (const cue of cues) {
            if (cue.time < timeStart || cue.time > timeStart + zoom) continue;
            const cueX = ((cue.time - timeStart) / zoom) * rect.width;
            if (Math.abs(relX - cueX) < 8) {
              specialCursor = "ew-resize";
              break;
            }
          }
        }

        e.currentTarget.style.cursor = specialCursor ?? (canDrag ? "grab" : "default");
      }
    },
    [zoom, beats, duration, trackId, draw, canDrag, isLocked, cues, onLockedPositionChange, onHoverTimeChange]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (draggingCueRef.current) {
        draggingCueRef.current = null;
        e.currentTarget.style.cursor = canDrag ? "grab" : "default";
        return;
      }
      if (draggingLoopRef.current) {
        draggingLoopRef.current = null;
        loopDragStartRegion.current = null;
        e.currentTarget.style.cursor = canDrag ? "grab" : "default";
        return;
      }
      isDragging.current = false;
      e.currentTarget.style.cursor = canDrag ? "grab" : "default";
    },
    [canDrag]
  );

  const handleMouseLeave = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    draggingCueRef.current = null;
    draggingLoopRef.current = null;
    loopDragStartRegion.current = null;
    isDragging.current = false;
    e.currentTarget.style.cursor = canDrag ? "grab" : "default";
    onHoverTimeChange?.(null);
  }, [canDrag, onHoverTimeChange]);

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
      {isLocked && (
        <button
          className="absolute top-1 left-1 z-20 flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-400 text-[9px] font-bold font-mono hover:bg-amber-500/30 transition-colors pointer-events-auto"
          onClick={(e) => { e.stopPropagation(); onUnlock?.(); }}
          title="Resume following playback (Esc)"
        >
          ▶ FOLLOW
        </button>
      )}
    </div>
  );
}
