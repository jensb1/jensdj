import { useCallback, useEffect } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { syncPlay } from "../../utils/syncPlay.ts";
import { Button } from "../ui/button.tsx";
import { debugLog } from "../../lib/debugLog.ts";

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
    debugLog("playbackControls.playClick", { trackId, isPlaying });
    await syncPlay(trackId);
    const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
    debugLog("playbackControls.playAfter", { trackId, playbackState });
  }, [trackId, isPlaying]);

  const handlePause = useCallback(async () => {
    debugLog("playbackControls.pauseClick", { trackId, isPlaying });
    await window.djRpc?.request?.pause?.({ trackId });
    setPlaying(trackId, false);
    const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
    debugLog("playbackControls.pauseAfter", { trackId, playbackState });
  }, [trackId, setPlaying, isPlaying]);

  const handleStop = useCallback(async () => {
    debugLog("playbackControls.stopClick", { trackId, isPlaying });
    await window.djRpc?.request?.stop?.({ trackId });
    setPlaying(trackId, false);
    window.dispatchEvent(new CustomEvent("dj:connectionsReset"));
    const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
    debugLog("playbackControls.stopAfter", { trackId, playbackState });
  }, [trackId, setPlaying, isPlaying]);

  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {isPlaying ? (
        <Button variant="ghost" size="icon" onClick={handlePause} className="text-emerald-400 hover:text-emerald-300">
          ⏸
        </Button>
      ) : (
        <Button variant="ghost" size="icon" onClick={handlePlay} className="text-zinc-300 hover:text-white">
          ▶
        </Button>
      )}
      <Button variant="ghost" size="icon" onClick={handleStop} className="text-zinc-500 hover:text-zinc-300">
        ⏹
      </Button>
    </div>
  );
}
