import { usePlayerStore } from "../stores/playerStore.ts";
import { buildScheduledBeatSyncPlan, buildSyncStartPlan, getBarDuration } from "../../shared/syncPlan.ts";
import { debugLog, logInfo } from "../lib/debugLog.ts";

const IMMEDIATE_BEAT_SYNC_MIN_WINDOW_SEC = 0.15;
const IMMEDIATE_BEAT_SYNC_MIN_PREROLL_SEC = 0.02;

interface SyncPlayOptions {
  targetAnchorPos?: number | null;
}

/**
 * Play a track, auto-syncing to any currently playing track.
 * Gets real source position from backend, then tells C engine to
 * start the target at a matching synced position.
 */
export async function syncPlay(trackId: string, options: SyncPlayOptions = {}): Promise<void> {
  const store = usePlayerStore.getState();
  const tracks = store.tracks;
  const thisTrack = tracks.get(trackId);
  if (!thisTrack) return;
  const explicitTargetAnchorPos =
    typeof options.targetAnchorPos === "number" && Number.isFinite(options.targetAnchorPos)
      ? options.targetAnchorPos
      : null;

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
    explicitTargetAnchorPos,
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
      // Auto-set master BPM if not set (prefer ID3 tag, fall back to analyzed BPM)
      const sourceBpm = source.track.metadata.bpm > 0 ? source.track.metadata.bpm : source.track.bpm;
      if (store.masterBpm === 0 && sourceBpm > 0) {
        store.setMasterBpm(sourceBpm);
        await window.djRpc?.request?.setMasterBpm?.({ bpm: sourceBpm });
      }



      // Get real positions from backend
      const targetState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
      const targetPos = targetState?.position ?? 0;
      const targetAnchorPos =
        explicitTargetAnchorPos ??
        thisTrack.lockedPosition ??
        thisTrack.previewPosition ??
        null;
      const syncPlanInput = {
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
        allowTransportPreserve: false,
      };

      const scheduledPlan = buildScheduledBeatSyncPlan(syncPlanInput);
      if (scheduledPlan) {
        const secondsUntilSourceBeat = scheduledPlan.sourceBeat - sourcePos;
        const availableTargetPreroll = scheduledPlan.targetBeat - Math.max(secondsUntilSourceBeat, 0);
        const immediateBeatSyncWindow = Math.max(
          IMMEDIATE_BEAT_SYNC_MIN_WINDOW_SEC,
          scheduledPlan.targetBeat - IMMEDIATE_BEAT_SYNC_MIN_PREROLL_SEC
        );
        const shouldUseImmediateBeatSync =
          secondsUntilSourceBeat >= 0 &&
          secondsUntilSourceBeat <= immediateBeatSyncWindow &&
          availableTargetPreroll >= IMMEDIATE_BEAT_SYNC_MIN_PREROLL_SEC;
        debugLog("syncPlay.schedulePlan", {
          trackId,
          sourceId,
          sourcePos: Number(sourcePos.toFixed(3)),
          targetPos: Number(targetPos.toFixed(3)),
          targetAnchorPos: targetAnchorPos != null ? Number(targetAnchorPos.toFixed(3)) : null,
          sourceBeat: Number(scheduledPlan.sourceBeat.toFixed(3)),
          targetBeat: Number(scheduledPlan.targetBeat.toFixed(3)),
          secondsUntilSourceBeat: Number(secondsUntilSourceBeat.toFixed(3)),
          availableTargetPreroll: Number(availableTargetPreroll.toFixed(3)),
          immediateBeatSyncWindow: Number(immediateBeatSyncWindow.toFixed(3)),
          shouldUseImmediateBeatSync,
        });

        if (shouldUseImmediateBeatSync) {
          const barDuration = getBarDuration(sourceBeats);
          logInfo("sync.immediateBeat", {
            trackId,
            sourceId,
            sourceBeat: Number(scheduledPlan.sourceBeat.toFixed(3)),
            targetBeat: Number(scheduledPlan.targetBeat.toFixed(3)),
            secondsUntilSourceBeat: Number(secondsUntilSourceBeat.toFixed(3)),
          });

          const ok = await window.djRpc?.request?.syncStart?.({
            targetTrackId: trackId,
            targetBeat: scheduledPlan.targetBeat,
            sourceTrackId: sourceId,
            sourceBeat: scheduledPlan.sourceBeat,
            barDuration,
            preserveTransport: false,
          });
          const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
          debugLog("syncPlay.immediateBeatResult", {
            trackId,
            ok,
            playbackState,
          });
          if (ok) {
            unlockVisualFollow();
            store.setPlaying(trackId, true);
            return;
          }
        } else {
          logInfo("sync.scheduleBeat", {
            trackId,
            sourceId,
            sourceBeat: Number(scheduledPlan.sourceBeat.toFixed(3)),
            targetBeat: Number(scheduledPlan.targetBeat.toFixed(3)),
          });

          const ok = await window.djRpc?.request?.scheduleSyncPlay?.({
            targetTrackId: trackId,
            targetBeatSeconds: scheduledPlan.targetBeat,
            sourceTrackId: sourceId,
            sourceBeatSeconds: scheduledPlan.sourceBeat,
          });
          const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
          debugLog("syncPlay.scheduleSyncResult", {
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

      const plan = buildSyncStartPlan(syncPlanInput);
      if (plan) {
        debugLog("syncPlay.plan", {
          trackId,
          sourceId,
          sourcePos: Number(sourcePos.toFixed(3)),
          targetPos: Number(targetPos.toFixed(3)),
          targetAnchorPos: targetAnchorPos != null ? Number(targetAnchorPos.toFixed(3)) : null,
          hasStartedPlayback: thisTrack.hasStartedPlayback,
          sourceBeat: Number(plan.sourceBeat.toFixed(3)),
          targetBeat: Number(plan.targetBeat.toFixed(3)),
          barDuration: Number(plan.barDuration.toFixed(3)),
          preserveTransport: plan.preserveTransport,
        });
        logInfo("sync.plan", {
          trackId,
          sourceId,
          targetAnchorPos: targetAnchorPos != null ? Number(targetAnchorPos.toFixed(3)) : null,
          hasStartedPlayback: thisTrack.hasStartedPlayback,
          targetBeat: Number(plan.targetBeat.toFixed(3)),
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
          logInfo("sync.start", {
            trackId,
            sourceId,
            playbackState,
          });
          unlockVisualFollow();
          store.setPlaying(trackId, true);
          return;
        }
      }
    }
  }

  // Fallback: normal play — auto-set master BPM so time-stretch is established
  const thisBpm = thisTrack.track.metadata.bpm > 0 ? thisTrack.track.metadata.bpm : thisTrack.track.bpm;
  if (store.masterBpm === 0 && thisBpm > 0) {
    store.setMasterBpm(thisBpm);
    await window.djRpc?.request?.setMasterBpm?.({ bpm: thisBpm });
  }
  await window.djRpc?.request?.play?.({
    trackId,
    fromTime: explicitTargetAnchorPos ?? undefined,
  });
  const playbackState = await window.djRpc?.request?.getPlaybackState?.({ trackId });
  debugLog("syncPlay.fallbackPlay", {
    trackId,
    explicitTargetAnchorPos,
    playbackState,
  });
  logInfo("playback.fallbackPlay", { trackId, explicitTargetAnchorPos, playbackState });
  unlockVisualFollow();
  store.setPlaying(trackId, true);
}
