import type { CuePoint } from "../../shared/types.ts";
import { buildCueSyncStartPlan } from "../../shared/syncPlan.ts";
import { logInfo } from "../lib/debugLog.ts";
import { useCueStore } from "../stores/cueStore.ts";
import { usePlayerStore } from "../stores/playerStore.ts";

function findTrackIdByFilePath(filePath: string): string | null {
  const tracks = usePlayerStore.getState().tracks;
  for (const [id, ts] of tracks) {
    if (ts.track.filePath === filePath) return id;
  }
  return null;
}

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
  const targetTrackId = connectedCue.trackId || findTrackIdByFilePath(connectedCue.filePath);
  if (!targetTrackId) return;
  const targetTrack = store.tracks.get(targetTrackId);

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
        targetTrackId,
        targetBeat: plan.targetBeat,
        sourceTrackId,
        sourceBeat: plan.sourceBeat,
        barDuration: plan.barDuration,
        preserveTransport: false,
      });

      if (ok) {
        unlockVisualFollow(targetTrackId);
        store.setPlaying(targetTrackId, true);
        logInfo("cue.startConnectedSync", {
          sourceTrackId,
          sourceCueId: sourceCue.id,
          sourceCueTime: Number(sourceCue.time.toFixed(3)),
          targetTrackId,
          targetCueId: connectedCue.id,
          targetCueTime: Number(connectedCue.time.toFixed(3)),
        });
        return;
      }
    }
  }

  await window.djRpc?.request?.play?.({
    trackId: targetTrackId,
    fromTime: connectedCue.time,
  });
  unlockVisualFollow(targetTrackId);
  store.setPlaying(targetTrackId, true);
  logInfo("cue.startConnectedFallback", {
    sourceTrackId,
    sourceCueId: sourceCue.id,
    targetTrackId,
    targetCueId: connectedCue.id,
    targetCueTime: Number(connectedCue.time.toFixed(3)),
  });
}

export async function activateCue(trackId: string, cue: CuePoint): Promise<void> {
  const connectAutos = cue.automations.filter((a) => a.type === "connect" && a.targetCueId);
  if (connectAutos.length > 0) {
    for (const auto of connectAutos) {
      const connectedCue = useCueStore.getState().cues.get(auto.targetCueId!);
      if (!connectedCue) continue;
      await startConnectedCue(trackId, cue, connectedCue);
      logInfo("cue.activateConnected", {
        sourceTrackId: trackId,
        cueId: cue.id,
        targetCueId: connectedCue.id,
        targetTime: Number(connectedCue.time.toFixed(3)),
      });
    }
    return;
  }

  await window.djRpc?.request?.seek?.({ trackId, seconds: cue.time });
  logInfo("cue.activateLocal", {
    trackId,
    cueId: cue.id,
    time: Number(cue.time.toFixed(3)),
  });
}
