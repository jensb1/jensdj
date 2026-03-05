import { useCallback } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { syncPlay } from "../../utils/syncPlay.ts";
import { Button } from "../ui/button.tsx";

interface PlaybackControlsProps {
  trackId: string;
  isPlaying: boolean;
}

export function PlaybackControls({ trackId, isPlaying }: PlaybackControlsProps) {
  const setPlaying = usePlayerStore((s) => s.setPlaying);

  const handlePlay = useCallback(() => syncPlay(trackId), [trackId]);

  const handlePause = useCallback(async () => {
    await window.djRpc?.request?.pause?.({ trackId });
    setPlaying(trackId, false);
  }, [trackId, setPlaying]);

  const handleStop = useCallback(async () => {
    await window.djRpc?.request?.stop?.({ trackId });
    setPlaying(trackId, false);
    window.dispatchEvent(new CustomEvent("dj:connectionsReset"));
  }, [trackId, setPlaying]);

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
