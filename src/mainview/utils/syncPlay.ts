import { usePlayerStore } from "../stores/playerStore.ts";
import { buildSyncStartPlan } from "../../shared/syncPlan.ts";
import { debugLog } from "../lib/debugLog.ts";

/**
 * Play a track, auto-syncing to any currently playing track.
 * Gets real source position from backend, then tells C engine to
 * start the target at a matching synced position.
 */
export async function syncPlay(trackId: string): Promise<void> {
  const store = usePlayerStore.getState();
  const tracks = store.tracks;
  const thisTrack = tracks.get(trackId);
  if (!thisTrack) return;

  const unlockVisualFollow = () => {
    debugLog("syncPlay.unlockVisualFollow", {
      trackId,
      previewPosition: thisTrack.previewPosition,
      lockedPosition: thisTrack.lockedPosition,
    });
    store.setPreviewPosition(trackId, null);
    store.setLockedPosition(trackId, null);
  };

  // Find another track that the backend confirms is actually playing.
  let sourceId: string | null = null;
  let sourcePos = 0;
  debugLog("syncPlay.begin", {
    trackId,
    storeIsPlaying: thisTrack.isPlaying,
    previewPosition: thisTrack.previewPosition,
    lockedPosition: thisTrack.lockedPosition,
  });
  for (const [id, st] of tracks.entries()) {
    if (id === trackId || !st.isPlaying) continue;
    const sourceState = await window.djRpc?.request?.getPlaybackState?.({ trackId: id });
    debugLog("syncPlay.inspectSource", {
      trackId,
      candidateSourceId: id,
      storeIsPlaying: st.isPlaying,
      backendState: sourceState,
    });
    if (sourceState?.isPlaying) {
      sourceId = id;
      sourcePos = sourceState.position ?? 0;
      break;
    }
    store.setPlaying(id, false);
  }

  if (sourceId) {
    const source = tracks.get(sourceId)!;
    const sourceBeats = source.track.beats;
    const targetBeats = thisTrack.track.beats;

    if (sourceBeats.length > 4 && targetBeats.length > 4) {
      // Auto-set master BPM if not set
      if (store.masterBpm === 0 && source.track.metadata.bpm > 0) {
        store.setMasterBpm(source.track.metadata.bpm);
        await window.djRpc?.request?.setMasterBpm?.({ bpm: source.track.metadata.bpm });
      }

      // Get real positions from backend
      const targetState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
      const targetPos = targetState?.position ?? 0;
      const targetAnchorPos =
        thisTrack.lockedPosition ??
        thisTrack.previewPosition ??
        null;

      const plan = buildSyncStartPlan({
        source: {
          beats: sourceBeats,
          filePath: source.track.filePath,
        },
        target: {
          beats: targetBeats,
          filePath: thisTrack.track.filePath,
        },
        sourcePos,
        targetPos,
        targetAnchorPos,
      });
      if (plan) {
        debugLog("syncPlay.plan", {
          trackId,
          sourceId,
          sourcePos: Number(sourcePos.toFixed(3)),
          targetPos: Number(targetPos.toFixed(3)),
          targetAnchorPos: targetAnchorPos != null ? Number(targetAnchorPos.toFixed(3)) : null,
          sourceBeat: Number(plan.sourceBeat.toFixed(3)),
          targetBeat: Number(plan.targetBeat.toFixed(3)),
          barDuration: Number(plan.barDuration.toFixed(3)),
          preserveTransport: plan.preserveTransport,
        });

        const ok = await window.djRpc?.request?.syncStart?.({
          targetTrackId: trackId,
          targetBeat: plan.targetBeat,
          sourceTrackId: sourceId,
          sourceBeat: plan.sourceBeat,
          barDuration: plan.barDuration,
          preserveTransport: plan.preserveTransport,
        });
        const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
        debugLog("syncPlay.syncStartResult", {
          trackId,
          ok,
          playbackState,
        });
        if (ok) {
          unlockVisualFollow();
          store.setPlaying(trackId, true);
          return;
        }
      }
    }
  }

  // Fallback: normal play
  await window.djRpc?.request?.play?.({ trackId });
  const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
  debugLog("syncPlay.fallbackPlay", {
    trackId,
    playbackState,
  });
  unlockVisualFollow();
  store.setPlaying(trackId, true);
}
