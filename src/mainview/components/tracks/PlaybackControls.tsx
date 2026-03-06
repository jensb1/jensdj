import { useCallback, useEffect } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { syncPlay } from "../../utils/syncPlay.ts";
import { Button } from "../ui/button.tsx";
import { debugLog, logInfo } from "../../lib/debugLog.ts";

interface PlaybackControlsProps {
  trackId: string;
  isPlaying: boolean;
}

export function PlaybackControls({ trackId, isPlaying }: PlaybackControlsProps) {
  const setPlaying = usePlayerStore((s) => s.setPlaying);

  useEffect(() => {
    debugLog("playbackControls.renderState", { trackId, isPlaying });
  }, [trackId, isPlaying]);

  const handlePlay = useCallback(async () => {
    await syncPlay(trackId);
    const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
    logInfo("playback.play", { trackId, playbackState });
  }, [trackId, isPlaying]);

  const handlePause = useCallback(async () => {
    await window.djRpc?.request?.pause?.({ trackId });
    setPlaying(trackId, false);
    const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
    logInfo("playback.pause", { trackId, playbackState });
  }, [trackId, setPlaying, isPlaying]);

  const handleStop = useCallback(async () => {
    await window.djRpc?.request?.stop?.({ trackId });
    setPlaying(trackId, false);
    window.dispatchEvent(new CustomEvent("dj:connectionsReset"));
    const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
    logInfo("playback.stop", { trackId, playbackState });
  }, [trackId, setPlaying, isPlaying]);

  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {isPlaying ? (
        <Button data-testid={`track-${trackId}-pause`} variant="ghost" size="icon" onClick={handlePause} className="text-emerald-400 hover:text-emerald-300">
          ⏸
        </Button>
      ) : (
        <Button data-testid={`track-${trackId}-play`} variant="ghost" size="icon" onClick={handlePlay} className="text-zinc-300 hover:text-white">
          ▶
        </Button>
      )}
      <Button data-testid={`track-${trackId}-stop`} variant="ghost" size="icon" onClick={handleStop} className="text-zinc-500 hover:text-zinc-300">
        ⏹
      </Button>
    </div>
  );
}
