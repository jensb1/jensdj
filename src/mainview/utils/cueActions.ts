import type { CuePoint } from "../../shared/types.ts";
import { logInfo } from "../lib/debugLog.ts";
import { useCueStore } from "../stores/cueStore.ts";
import { usePlayerStore } from "../stores/playerStore.ts";
import { syncPlay } from "./syncPlay.ts";

export async function activateCue(trackId: string, cue: CuePoint): Promise<void> {
  const connectedCue = cue.connectedCueId
    ? useCueStore.getState().cues.get(cue.connectedCueId)
    : null;

  if (connectedCue) {
    await window.djRpc?.request?.seek?.({
      trackId: connectedCue.trackId,
      seconds: connectedCue.time,
    });

    const targetTrack = usePlayerStore.getState().tracks.get(connectedCue.trackId);
    if (!targetTrack?.isPlaying) {
      await syncPlay(connectedCue.trackId);
    }

    logInfo("cue.activateConnected", {
      sourceTrackId: trackId,
      cueId: cue.id,
      targetTrackId: connectedCue.trackId,
      targetCueId: connectedCue.id,
      targetTime: Number(connectedCue.time.toFixed(3)),
    });
    return;
  }

  await window.djRpc?.request?.seek?.({ trackId, seconds: cue.time });
  logInfo("cue.activateLocal", {
    trackId,
    cueId: cue.id,
    time: Number(cue.time.toFixed(3)),
  });
}
