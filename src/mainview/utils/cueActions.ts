import type { CuePoint } from "../../shared/types.ts";
import { buildCueSyncStartPlan } from "../../shared/syncPlan.ts";
import { logInfo } from "../lib/debugLog.ts";
import { useCueStore } from "../stores/cueStore.ts";
import { usePlayerStore } from "../stores/playerStore.ts";

function unlockVisualFollow(trackId: string): void {
  const store = usePlayerStore.getState();
  store.setPreviewPosition(trackId, null);
  store.setLockedPosition(trackId, null);
}

export async function startConnectedCue(
  sourceTrackId: string,
  sourceCue: CuePoint,
  connectedCue: CuePoint
): Promise<void> {
  const store = usePlayerStore.getState();
  const sourceTrack = store.tracks.get(sourceTrackId);
  const targetTrack = store.tracks.get(connectedCue.trackId);

  if (!targetTrack) return;

  const sourceState = sourceTrack
    ? await window.djRpc?.request?.getPlaybackState?.({ trackId: sourceTrackId })
    : null;

  if (sourceTrack && sourceState?.isPlaying) {
    const plan = buildCueSyncStartPlan({
      source: {
        beats: sourceTrack.track.beats,
        filePath: sourceTrack.track.filePath,
      },
      sourceCueTime: sourceCue.time,
      targetCueTime: connectedCue.time,
    });

    if (plan) {
      const ok = await window.djRpc?.request?.syncStart?.({
        targetTrackId: connectedCue.trackId,
        targetBeat: plan.targetBeat,
        sourceTrackId,
        sourceBeat: plan.sourceBeat,
        barDuration: plan.barDuration,
        preserveTransport: false,
      });

      if (ok) {
        unlockVisualFollow(connectedCue.trackId);
        store.setPlaying(connectedCue.trackId, true);
        logInfo("cue.startConnectedSync", {
          sourceTrackId,
          sourceCueId: sourceCue.id,
          sourceCueTime: Number(sourceCue.time.toFixed(3)),
          targetTrackId: connectedCue.trackId,
          targetCueId: connectedCue.id,
          targetCueTime: Number(connectedCue.time.toFixed(3)),
        });
        return;
      }
    }
  }

  await window.djRpc?.request?.play?.({
    trackId: connectedCue.trackId,
    fromTime: connectedCue.time,
  });
  unlockVisualFollow(connectedCue.trackId);
  store.setPlaying(connectedCue.trackId, true);
  logInfo("cue.startConnectedFallback", {
    sourceTrackId,
    sourceCueId: sourceCue.id,
    targetTrackId: connectedCue.trackId,
    targetCueId: connectedCue.id,
    targetCueTime: Number(connectedCue.time.toFixed(3)),
  });
}

export async function activateCue(trackId: string, cue: CuePoint): Promise<void> {
  const connectedCue = cue.connectedCueId
    ? useCueStore.getState().cues.get(cue.connectedCueId)
    : null;

  if (connectedCue) {
    await startConnectedCue(trackId, cue, connectedCue);
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
