import { useCallback, useRef, useEffect, useState } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { PlaybackControls } from "./PlaybackControls.tsx";
import { Waveform } from "./Waveform.tsx";
import { ZoomedWaveform } from "./ZoomedWaveform.tsx";
import { Slider } from "../ui/slider.tsx";
import { Button } from "../ui/button.tsx";
import { OutputSelector } from "../mixer/OutputSelector.tsx";
import { EQControls } from "../mixer/EQControls.tsx";
import { LevelMeter } from "../mixer/LevelMeter.tsx";

interface TrackRowProps {
  trackId: string;
  state: {
    track: {
      metadata: { title: string; artist: string; bpm: number };
      duration: number;
      peaks: number[];
      beats: number[];
    };
    position: number;
    isPlaying: boolean;
    volume: number;
    deviceId: number;
  };
  onWaveformRef?: (el: HTMLDivElement | null) => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function TrackRow({ trackId, state, onWaveformRef }: TrackRowProps) {
  const removeTrack = usePlayerStore((s) => s.removeTrack);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [editingBpm, setEditingBpm] = useState(false);
  const [bpmValue, setBpmValue] = useState(
    state.track.metadata.bpm > 0 ? state.track.metadata.bpm.toFixed(1) : ""
  );
  const [customBeats, setCustomBeats] = useState<number[] | null>(null);
  const [downbeatOffset, setDownbeatOffset] = useState(0); // 0-3: which beat index is "1"

  // Direct DOM update for time display — no React re-render
  useEffect(() => {
    const handler = (e: Event) => {
      const { trackId: tid, position } = (e as CustomEvent).detail;
      if (tid !== trackId) return;
      if (timeRef.current) timeRef.current.textContent = formatTime(position);
    };
    window.addEventListener("dj:playbackTick", handler);
    return () => window.removeEventListener("dj:playbackTick", handler);
  }, [trackId]);

  const handleRemove = useCallback(async () => {
    await window.djRpc?.request?.unloadTrack?.({ trackId });
    removeTrack(trackId);
  }, [trackId, removeTrack]);

  const handleVolumeChange = useCallback(
    (value: number[]) => {
      const vol = value[0] ?? 1;
      usePlayerStore.getState().setVolume(trackId, vol);
      window.djRpc?.request?.setVolume?.({ trackId, volume: vol });
    },
    [trackId]
  );

  const handleSeek = useCallback(
    (seconds: number) => {
      window.djRpc?.request?.seek?.({ trackId, seconds });
    },
    [trackId]
  );

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

  return (
    <div className="border-b border-zinc-800/50 bg-zinc-900/30 hover:bg-zinc-900/60 transition-colors">
      {/* Zoomed waveform — scrolls with playhead centered */}
      <div className="px-4 pt-2">
        <ZoomedWaveform
          trackId={trackId}
          peaks={state.track.peaks}
          duration={state.track.duration}
          beats={displayBeats}
          downbeatOffset={downbeatOffset}
          zoom={10}
        />
      </div>
      <div className="flex items-center gap-3 px-4 py-2">
        <PlaybackControls trackId={trackId} isPlaying={state.isPlaying} />

        {/* Track info */}
        <div className="w-44 shrink-0 min-w-0">
          <div className="text-sm font-medium text-zinc-100 truncate">
            {state.track.metadata.title}
          </div>
          <div className="text-[11px] text-zinc-500 truncate">
            {state.track.metadata.artist}
          </div>
        </div>

        {/* BPM + downbeat */}
        <div className="w-20 shrink-0 text-center flex flex-col items-center gap-0.5">
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
              className="w-14 h-5 text-[11px] font-mono font-bold text-center bg-zinc-700 text-amber-300 border border-amber-500/50 rounded outline-none px-1"
            />
          ) : (
            <span
              className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 cursor-pointer hover:bg-amber-500/20 transition-colors"
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
            className="text-[9px] font-mono px-1 py-0.5 rounded bg-zinc-800 text-zinc-500 cursor-pointer hover:text-amber-400 hover:bg-zinc-700 transition-colors"
            onClick={() => setDownbeatOffset((downbeatOffset + 1) % 4)}
            title={`Downbeat offset: ${downbeatOffset + 1}/4 — click to shift`}
          >
            1:{downbeatOffset + 1}
          </span>
        </div>

        {/* Canvas waveform with beat grid */}
        <Waveform
          trackId={trackId}
          peaks={state.track.peaks}
          duration={state.track.duration}
          beats={displayBeats}
          downbeatOffset={downbeatOffset}
          onSeek={handleSeek}
          onContainerRef={onWaveformRef}
        />

        {/* Time display */}
        <div className="w-24 shrink-0 text-center">
          <span ref={timeRef} className="font-mono text-xs text-zinc-400">
            {formatTime(state.position)}
          </span>
          <span className="text-zinc-700 mx-0.5">/</span>
          <span className="font-mono text-[11px] text-zinc-600">
            {formatTime(state.track.duration)}
          </span>
        </div>

        {/* EQ */}
        <EQControls trackId={trackId} />

        {/* Level meter */}
        <LevelMeter trackId={trackId} />

        {/* Output device */}
        <OutputSelector trackId={trackId} currentDeviceId={state.deviceId} />

        {/* Volume */}
        <div className="w-20 shrink-0">
          <Slider
            value={[state.volume]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={handleVolumeChange}
          />
        </div>

        <Button variant="ghost" size="icon" onClick={handleRemove} className="text-zinc-600 hover:text-red-400">
          ✕
        </Button>
      </div>
    </div>
  );
}
