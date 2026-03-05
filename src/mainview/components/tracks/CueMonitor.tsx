import { useEffect, useRef } from "react";
import { useCueStore } from "../../stores/cueStore.ts";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { syncPlay } from "../../utils/syncPlay.ts";

/**
 * Watches playback position and triggers cue connection actions:
 * - start: start the connected track (synced to downbeat)
 * - stop: stop this track
 * - loop: set a 4-bar loop on the connected track
 */
export function CueMonitor() {
  const cues = useCueStore((s) => s.cues);
  const firedCues = useRef<Set<string>>(new Set());

  useEffect(() => {
    const handler = (e: Event) => {
      const { trackId, position } = (e as CustomEvent).detail;

      for (const [, cue] of cues) {
        if (cue.trackId !== trackId) continue;
        if (!cue.connectedCueId) continue;
        if (firedCues.current.has(cue.id)) continue;

        // Trigger when playback is within 50ms of the cue
        if (Math.abs(position - cue.time) > 0.05) continue;

        const connectedCue = cues.get(cue.connectedCueId);
        if (!connectedCue) continue;

        firedCues.current.add(cue.id);
        const action = cue.connectionAction ?? "start";
        const targetTrackId = connectedCue.trackId;

        console.log(`[CueMonitor] ${cue.label}@${cue.time.toFixed(2)}s → ${connectedCue.label} action=${action}`);

        switch (action) {
          case "start": {
            const targetState = usePlayerStore.getState().tracks.get(targetTrackId);
            if (targetState && !targetState.isPlaying) {
              // Seek to connected cue's position first, then sync play
              window.djRpc?.request?.seek?.({ trackId: targetTrackId, seconds: connectedCue.time });
              syncPlay(targetTrackId);
            }
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
    const handler = () => { firedCues.current.clear(); };
    window.addEventListener("dj:connectionsReset", handler);
    return () => window.removeEventListener("dj:connectionsReset", handler);
  }, []);

  return null;
}
