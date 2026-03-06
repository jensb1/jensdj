import { useCallback, useRef, useEffect, useState, useMemo } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { PlaybackControls } from "./PlaybackControls.tsx";
import { Waveform } from "./Waveform.tsx";
import { ZoomedWaveform } from "./ZoomedWaveform.tsx";
import { Button } from "../ui/button.tsx";
import { EQControls } from "../mixer/EQControls.tsx";
import { OutputSelector } from "../mixer/OutputSelector.tsx";
import { CueToolbar } from "./CueToolbar.tsx";
import { useCueStore } from "../../stores/cueStore.ts";
import type { Peaks3Band, CuePoint } from "../../../shared/types.ts";
import { debugLog } from "../../lib/debugLog.ts";
import { syncPlay } from "../../utils/syncPlay.ts";

interface TrackRowProps {
  trackId: string;
  state: {
    track: {
      metadata: { title: string; artist: string; bpm: number };
      duration: number;
      peaks: Peaks3Band;
      beats: number[];
    };
    position: number;
    isPlaying: boolean;
    volume: number;
    deviceId: number;
    previewPosition: number | null;
    lockedPosition: number | null;
  };
  onWaveformRef?: (el: HTMLDivElement | null) => void;
}

function VolumeFader({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const svgRef = useRef<SVGSVGElement>(null);

  const getVolFromY = useCallback((clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return value;
    const rect = svg.getBoundingClientRect();
    const pct = 1 - (clientY - rect.top) / rect.height;
    return Math.max(0, Math.min(1, pct));
  }, [value]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onChange(getVolFromY(e.clientY));
    const onMove = (ev: MouseEvent) => onChange(getVolFromY(ev.clientY));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [onChange, getVolFromY]);

  const h = 90;
  const w = 16;
  const trackX = w / 2;
  const fillH = value * h;
  const thumbY = h - fillH;

  return (
    <svg
      ref={svgRef}
      width={w}
      height={h}
      className="cursor-ns-resize select-none"
      onMouseDown={handleMouseDown}
    >
      {/* Track */}
      <rect x={trackX - 2} y={0} width={4} height={h} rx={2} fill="#3f3f46" />
      {/* Fill */}
      <rect x={trackX - 2} y={h - fillH} width={4} height={fillH} rx={2} fill="#3b82f6" />
      {/* Thumb */}
      <rect x={trackX - 6} y={thumbY - 4} width={12} height={8} rx={2} fill="#d4d4d8" stroke="#a1a1aa" strokeWidth={0.5} />
      {/* Center line on thumb */}
      <line x1={trackX - 3} y1={thumbY} x2={trackX + 3} y2={thumbY} stroke="#71717a" strokeWidth={0.5} />
    </svg>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatPreciseTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

export function TrackRow({ trackId, state, onWaveformRef }: TrackRowProps) {
  const removeTrack = usePlayerStore((s) => s.removeTrack);
  const cuesMap = useCueStore((s) => s.cues);
  const trackCues = useMemo(() => {
    const result: CuePoint[] = [];
    for (const cue of cuesMap.values()) {
      if (cue.trackId === trackId) result.push(cue);
    }
    return result;
  }, [cuesMap, trackId]);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [editingBpm, setEditingBpm] = useState(false);
  const [bpmValue, setBpmValue] = useState(
    state.track.metadata.bpm > 0 ? state.track.metadata.bpm.toFixed(1) : ""
  );
  const [customBeats, setCustomBeats] = useState<number[] | null>(null);
  const [downbeatOffset, setDownbeatOffset] = useState(0); // 0-3: which beat index is "1"
  const [zoomHoverTime, setZoomHoverTime] = useState<number | null>(null);

  const positionRef = useRef(state.position);

  // Direct DOM update for time display — no React re-render
  useEffect(() => {
    const handler = (e: Event) => {
      const { trackId: tid, position } = (e as CustomEvent).detail;
      if (tid !== trackId) return;
      positionRef.current = position;
      if (timeRef.current) timeRef.current.textContent = formatTime(position);
    };
    window.addEventListener("dj:playbackTick", handler);
    return () => window.removeEventListener("dj:playbackTick", handler);
  }, [trackId]);

  useEffect(() => {
    debugLog("trackRow.state", {
      trackId,
      isPlaying: state.isPlaying,
      previewPosition: state.previewPosition,
      lockedPosition: state.lockedPosition,
      storePosition: Number(state.position.toFixed(3)),
    });
  }, [trackId, state.isPlaying, state.previewPosition, state.lockedPosition, state.position]);

  const handleRemove = useCallback(async () => {
    await window.djRpc?.request?.unloadTrack?.({ trackId });
    removeTrack(trackId);
  }, [trackId, removeTrack]);

  const setPreviewPosition = usePlayerStore((s) => s.setPreviewPosition);
  const setLockedPosition = usePlayerStore((s) => s.setLockedPosition);

  const handleSeek = useCallback(
    (seconds: number) => {
      positionRef.current = seconds;
      window.djRpc?.request?.seek?.({ trackId, seconds });
    },
    [trackId]
  );

  const handlePreview = useCallback(
    (seconds: number | null) => {
      debugLog("trackRow.preview", {
        trackId,
        seconds,
        isPlaying: state.isPlaying,
      });
      setPreviewPosition(trackId, seconds);
      // Also lock zoomed waveform to preview position
      if (seconds !== null) {
        setLockedPosition(trackId, seconds);
      }
    },
    [trackId, setPreviewPosition, setLockedPosition, state.isPlaying]
  );

  const handleLockedPositionChange = useCallback(
    (pos: number) => {
      debugLog("trackRow.lockedPositionChange", {
        trackId,
        pos,
        isPlaying: state.isPlaying,
      });
      setLockedPosition(trackId, pos);
    },
    [trackId, setLockedPosition, state.isPlaying]
  );

  const handlePlayFromPreview = useCallback(async (seconds: number) => {
    positionRef.current = seconds;
    await syncPlay(trackId, { targetAnchorPos: seconds });
  }, [trackId]);

  const handleCueDrag = useCallback(
    (time: number | null) => {
      setLockedPosition(trackId, time);
    },
    [trackId, setLockedPosition]
  );

  // Space = lock at current preview, Esc = unlock
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.code === "Escape") {
        setLockedPosition(trackId, null);
        setPreviewPosition(trackId, null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [trackId, setLockedPosition, setPreviewPosition]);

  // BPM editing — recalculates beat grid from manual BPM
  const handleBpmSubmit = useCallback(() => {
    const newBpm = parseFloat(bpmValue);
    if (!newBpm || newBpm <= 0 || newBpm > 300) {
      setEditingBpm(false);
      return;
    }
    // Recalculate evenly-spaced beats from the new BPM
    const beatInterval = 60 / newBpm;
    const beats: number[] = [];
    // Find the first beat from original data to keep phase alignment
    const firstBeat = state.track.beats.length > 0 ? (state.track.beats[0] ?? 0) : 0;
    let t: number = firstBeat;
    while (t < state.track.duration) {
      beats.push(t);
      t += beatInterval;
    }
    setCustomBeats(beats);
    setEditingBpm(false);
  }, [bpmValue, state.track.beats, state.track.duration]);

  const displayBeats = customBeats ?? state.track.beats;
  const displayBpm = customBeats
    ? parseFloat(bpmValue)
    : state.track.metadata.bpm;
  const currentPosition = positionRef.current;

  return (
    <div data-testid={`track-row-${trackId}`} className="border-b border-zinc-800/50 bg-zinc-900/30 hover:bg-zinc-900/60 transition-colors">
      {/* Top row: mixer square + zoomed waveform */}
      <div className="flex px-4 pt-2 gap-2">
        {/* Mixer square: EQ knobs + volume fader */}
        <div className="shrink-0 flex gap-1.5 bg-zinc-800/50 rounded-md px-1.5 py-1 h-28 items-center">
          <EQControls trackId={trackId} layout="vertical" />
          {/* Volume fader — custom slim track */}
          <VolumeFader
            value={state.volume}
            onChange={(vol) => {
              usePlayerStore.getState().setVolume(trackId, vol);
              window.djRpc?.request?.setVolume?.({ trackId, volume: vol });
            }}
          />
        </div>

        {/* Zoomed waveform */}
        <div className="flex-1 relative">
          {zoomHoverTime != null && (
            <div className="absolute top-1 right-2 z-20 rounded bg-black/70 px-1.5 py-px text-[8px] font-mono text-zinc-300 pointer-events-none">
              {formatPreciseTime(zoomHoverTime)}
            </div>
          )}
          <ZoomedWaveform
            trackId={trackId}
            peaks={state.track.peaks}
            duration={state.track.duration}
            beats={displayBeats}
            downbeatOffset={downbeatOffset}
            zoom={10}
            isPlaying={state.isPlaying}
            position={currentPosition}
            lockedPosition={state.lockedPosition}
            onLockedPositionChange={handleLockedPositionChange}
            onHoverTimeChange={setZoomHoverTime}
            cues={trackCues}
          />
        </div>
      </div>

      {/* Bottom row: controls + overview waveform + output + close */}
      <div className="flex items-center gap-2 px-4 py-1">
        <PlaybackControls trackId={trackId} isPlaying={state.isPlaying} />

        {/* Track info */}
        <div className="w-32 shrink-0 min-w-0">
          <div className="text-[11px] font-medium text-zinc-100 truncate">
            {state.track.metadata.title}
          </div>
          <div className="text-[9px] text-zinc-500 truncate">
            {state.track.metadata.artist}
          </div>
        </div>

        {/* BPM + downbeat */}
        <div className="shrink-0 flex items-center gap-1">
          {editingBpm ? (
            <input
              type="text"
              value={bpmValue}
              onChange={(e) => setBpmValue(e.target.value)}
              onBlur={handleBpmSubmit}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleBpmSubmit();
                if (e.key === "Escape") setEditingBpm(false);
              }}
              autoFocus
              className="w-12 h-4 text-[10px] font-mono font-bold text-center bg-zinc-700 text-amber-300 border border-amber-500/50 rounded outline-none"
            />
          ) : (
            <span
              className="text-[10px] font-mono font-bold px-1 py-0.5 rounded bg-amber-500/10 text-amber-400 cursor-pointer hover:bg-amber-500/20"
              onClick={() => {
                setBpmValue(displayBpm > 0 ? displayBpm.toFixed(1) : "");
                setEditingBpm(true);
              }}
              title="Click to edit BPM"
            >
              {displayBpm > 0 ? displayBpm.toFixed(1) : "---"}
            </span>
          )}
          <span
            className="text-[8px] font-mono px-0.5 rounded bg-zinc-800 text-zinc-500 cursor-pointer hover:text-amber-400"
            onClick={() => setDownbeatOffset((downbeatOffset + 1) % 4)}
            title="Click to shift downbeat"
          >
            1:{downbeatOffset + 1}
          </span>
          {displayBpm > 0 && (
            <span
              className="text-[7px] font-bold px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-400 cursor-pointer hover:bg-emerald-500/20"
              onClick={() => {
                usePlayerStore.getState().setMasterBpm(displayBpm);
                window.djRpc?.request?.setMasterBpm?.({ bpm: displayBpm });
              }}
              title="Set as master tempo"
            >
              SYNC
            </span>
          )}
        </div>

        {/* Cue toolbar */}
        <CueToolbar trackId={trackId} getPosition={() => state.lockedPosition ?? positionRef.current} beats={displayBeats} />

        {/* Overview waveform */}
        <Waveform
          trackId={trackId}
          peaks={state.track.peaks}
          duration={state.track.duration}
          beats={displayBeats}
          downbeatOffset={downbeatOffset}
          isPlaying={state.isPlaying}
          position={currentPosition}
          previewPosition={state.previewPosition}
          cues={trackCues}
          onSeek={handleSeek}
          onPreview={handlePreview}
          onPlayFromPreview={handlePlayFromPreview}
          onContainerRef={onWaveformRef}
          onCueDrag={handleCueDrag}
        />

        {/* Time */}
        <span ref={timeRef} className="font-mono text-[10px] text-zinc-400 shrink-0">
          {formatTime(currentPosition)}
        </span>
        <span className="font-mono text-[9px] text-zinc-600 shrink-0">
          {formatTime(state.track.duration)}
        </span>

        {/* Output selector */}
        <OutputSelector trackId={trackId} currentDeviceId={state.deviceId} compact />

        <Button variant="ghost" size="icon" onClick={handleRemove} className="text-zinc-600 hover:text-red-400 h-5 w-5 shrink-0">
          ✕
        </Button>
      </div>
    </div>
  );
}
