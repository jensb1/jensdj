import { usePlayerStore } from "../stores/playerStore.ts";

function nextDownbeat(beats: number[], position: number): number {
  for (let i = 0; i < beats.length; i += 4) {
    if ((beats[i] ?? 0) >= position - 0.01) return beats[i] ?? 0;
  }
  return position;
}

function nearestDownbeat(beats: number[], position: number): number {
  let best = beats[0] ?? 0;
  let minDist = Infinity;
  for (let i = 0; i < beats.length; i += 4) {
    const d = Math.abs((beats[i] ?? 0) - position);
    if (d < minDist) { minDist = d; best = beats[i] ?? 0; }
  }
  return best;
}

/**
 * Play a track, auto-syncing to any currently playing track's downbeat.
 * Falls back to normal play if no other track is playing or no beat data.
 */
export async function syncPlay(trackId: string): Promise<void> {
  const store = usePlayerStore.getState();
  const tracks = store.tracks;
  const thisTrack = tracks.get(trackId);
  if (!thisTrack) return;

  // Find another playing track
  let sourceId: string | null = null;
  for (const [id, st] of tracks.entries()) {
    if (id !== trackId && st.isPlaying) { sourceId = id; break; }
  }

  if (sourceId) {
    const source = tracks.get(sourceId)!;
    const sourceBeats = source.track.beats;
    const targetBeats = thisTrack.track.beats;

    if (sourceBeats.length > 0 && targetBeats.length > 0) {
      // Auto-set master BPM if not set
      if (store.masterBpm === 0 && source.track.metadata.bpm > 0) {
        store.setMasterBpm(source.track.metadata.bpm);
        await window.djRpc?.request?.setMasterBpm?.({ bpm: source.track.metadata.bpm });
      }

      const sourceDownbeat = nextDownbeat(sourceBeats, source.position);
      const targetDownbeat = nearestDownbeat(targetBeats, thisTrack.position);

      const ok = await window.djRpc?.request?.scheduleSyncPlay?.({
        targetTrackId: trackId,
        targetBeatSeconds: targetDownbeat,
        sourceTrackId: sourceId,
        sourceBeatSeconds: sourceDownbeat,
      });
      if (ok) {
        store.setPlaying(trackId, true);
        return;
      }
    }
  }

  // Fallback: normal play
  await window.djRpc?.request?.play?.({ trackId });
  store.setPlaying(trackId, true);
}
