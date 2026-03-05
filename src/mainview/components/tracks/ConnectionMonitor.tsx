import { useEffect, useRef } from "react";
import { useConnectionStore } from "../../stores/connectionStore.ts";
import { usePlayerStore } from "../../stores/playerStore.ts";

/**
 * Monitors connections and schedules sample-accurate sync playback
 * via the native C engine. When a connection is created and the source
 * track is playing, it calls scheduleSyncPlay which uses miniaudio's
 * engine clock to start the target at the exact right PCM frame.
 */
export function ConnectionMonitor() {
  const connections = useConnectionStore((s) => s.connections);
  const scheduledConnections = useRef<Set<string>>(new Set());

  // When connections change or tracks start playing, schedule sync
  useEffect(() => {
    const scheduleConnections = () => {
      const tracks = usePlayerStore.getState().tracks;

      for (const conn of connections) {
        if (scheduledConnections.current.has(conn.id)) continue;

        const sourceState = tracks.get(conn.sourceTrackId);
        if (!sourceState?.isPlaying) continue;

        // Source is playing — schedule the target via native engine
        scheduledConnections.current.add(conn.id);

        console.log(
          `[ConnectionMonitor] Scheduling: ${conn.sourceTrackId}@${conn.sourceBeatTime.toFixed(2)}s → ${conn.targetTrackId}@${conn.targetBeatTime.toFixed(2)}s`
        );

        window.djRpc?.request?.scheduleSyncPlay?.({
          targetTrackId: conn.targetTrackId,
          targetBeatSeconds: conn.targetBeatTime,
          sourceTrackId: conn.sourceTrackId,
          sourceBeatSeconds: conn.sourceBeatTime,
        }).then((ok) => {
          if (ok) {
            // Mark target as playing (it will start when scheduled)
            usePlayerStore.getState().setPlaying(conn.targetTrackId, true);
          }
        });
      }
    };

    // Check immediately
    scheduleConnections();

    // Also check on every playback tick (for connections made before play starts)
    const handler = () => scheduleConnections();
    window.addEventListener("dj:playbackTick", handler);
    return () => window.removeEventListener("dj:playbackTick", handler);
  }, [connections]);

  // Reset when tracks are stopped
  useEffect(() => {
    const handler = () => {
      scheduledConnections.current.clear();
    };
    window.addEventListener("dj:connectionsReset", handler);
    return () => window.removeEventListener("dj:connectionsReset", handler);
  }, []);

  return null;
}
