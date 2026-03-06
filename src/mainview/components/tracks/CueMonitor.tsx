import { useEffect, useRef } from "react";
import { useCueStore } from "../../stores/cueStore.ts";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { logInfo } from "../../lib/debugLog.ts";
import { startConnectedCue } from "../../utils/cueActions.ts";
import { hasCrossedCue, shouldRearmCue } from "../../utils/cueTrigger.ts";

/**
 * Watches playback position and triggers cue connection actions:
 * - start: start the connected track synced cue-to-cue
 * - stop: stop this track
 * - loop: set a 4-bar loop on the connected track
 */
export function CueMonitor() {
  const cues = useCueStore((s) => s.cues);
  const firedCues = useRef<Set<string>>(new Set());
  const lastPositions = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const handler = (e: Event) => {
      const { trackId, position, isPlaying } = (e as CustomEvent).detail as {
        trackId: string;
        position: number;
        isPlaying?: boolean;
      };
      const previousPosition = lastPositions.current.get(trackId);
      lastPositions.current.set(trackId, position);

      for (const [, cue] of cues) {
        if (cue.trackId !== trackId) continue;
        if (!cue.connectedCueId) continue;
        if (shouldRearmCue(position, cue.time)) {
          firedCues.current.delete(cue.id);
        }
        if (!isPlaying) continue;
        if (firedCues.current.has(cue.id)) continue;

        if (!hasCrossedCue(previousPosition, position, cue.time)) continue;

        const connectedCue = cues.get(cue.connectedCueId);
        if (!connectedCue) continue;

        firedCues.current.add(cue.id);
        const action = cue.connectionAction ?? "start";
        const targetTrackId = connectedCue.trackId;

        logInfo("cue.monitorTrigger", {
          sourceTrackId: trackId,
          cueId: cue.id,
          cueLabel: cue.label,
          cueTime: Number(cue.time.toFixed(3)),
          targetTrackId,
          targetCueId: connectedCue.id,
          targetCueTime: Number(connectedCue.time.toFixed(3)),
          action,
          position: Number(position.toFixed(3)),
          previousPosition: previousPosition != null ? Number(previousPosition.toFixed(3)) : null,
        });

        switch (action) {
          case "start": {
            void startConnectedCue(trackId, cue, connectedCue);
            break;
          }
          case "stop": {
            window.djRpc?.request?.stop?.({ trackId: targetTrackId });
            usePlayerStore.getState().setPlaying(targetTrackId, false);
            break;
          }
          case "loop": {
            // 4-bar loop starting at the connected cue
            const targetState = usePlayerStore.getState().tracks.get(targetTrackId);
            const bpm = targetState?.track.metadata.bpm ?? 120;
            const fourBars = 4 * (60 / bpm) * 4; // 4 bars = 16 beats
            window.djRpc?.request?.setLoop?.({
              trackId: targetTrackId,
              startSec: connectedCue.time,
              endSec: connectedCue.time + fourBars,
            });
            break;
          }
        }
      }
    };

    window.addEventListener("dj:playbackTick", handler);
    return () => window.removeEventListener("dj:playbackTick", handler);
  }, [cues]);

  // Reset fired cues when tracks stop
  useEffect(() => {
    const handler = () => {
      firedCues.current.clear();
      lastPositions.current.clear();
    };
    window.addEventListener("dj:connectionsReset", handler);
    return () => window.removeEventListener("dj:connectionsReset", handler);
  }, []);

  return null;
}
