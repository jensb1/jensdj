import { useEffect, useRef } from "react";
import { useCueStore } from "../../stores/cueStore.ts";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { logInfo } from "../../lib/debugLog.ts";
import { startConnectedCue } from "../../utils/cueActions.ts";
import { hasCrossedCue, shouldRearmCue } from "../../utils/cueTrigger.ts";
import type { CueAutomation } from "../../../shared/types.ts";
import { DJ_PARAM_FILTER, DJ_PARAM_VOLUME, DJ_PARAM_EQ_LO, DJ_PARAM_EQ_MID, DJ_PARAM_EQ_HI, DJ_INTERP_LINEAR, DJ_INTERP_EASE_IN, DJ_INTERP_EASE_OUT } from "../../../shared/types.ts";

function interpToNative(interp: CueAutomation["interpolation"]): number {
  switch (interp) {
    case "easeIn": return DJ_INTERP_EASE_IN;
    case "easeOut": return DJ_INTERP_EASE_OUT;
    default: return DJ_INTERP_LINEAR;
  }
}

function barsToSeconds(bars: number, bpm: number): number {
  return bars * 4 * (60 / bpm); // 4 beats per bar
}

/**
 * Watches playback position and triggers cue automations:
 * - connect: start the connected track synced cue-to-cue
 * - stop: stop this track (with optional volume fade)
 * - loop: set a 4-bar loop at cue position
 * - filter_lp / filter_hp: sweep filter over N bars via C engine
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
        if (!cue.active) continue;
        if (cue.automations.length === 0) continue;
        if (shouldRearmCue(position, cue.time)) {
          firedCues.current.delete(cue.id);
        }
        if (!isPlaying) continue;
        if (firedCues.current.has(cue.id)) continue;

        if (!hasCrossedCue(previousPosition, position, cue.time)) continue;

        firedCues.current.add(cue.id);

        const trackState = usePlayerStore.getState().tracks.get(trackId);
        const bpm = trackState?.track.bpm ?? 120;

        for (const auto of cue.automations) {
          logInfo("cue.automationTrigger", {
            sourceTrackId: trackId,
            cueId: cue.id,
            cueLabel: cue.label,
            type: auto.type,
            durationBars: auto.durationBars,
            position: Number(position.toFixed(3)),
          });

          switch (auto.type) {
            case "connect": {
              if (!auto.targetCueId) break;
              const connectedCue = cues.get(auto.targetCueId);
              if (!connectedCue) break;
              void startConnectedCue(trackId, cue, connectedCue);
              break;
            }

            case "stop": {
              if (auto.durationBars > 0) {
                // Fade out over N bars, then stop
                const durationSec = barsToSeconds(auto.durationBars, bpm);
                window.djRpc?.request?.setAutomation?.({
                  trackId,
                  param: DJ_PARAM_VOLUME,
                  startVal: trackState?.volume ?? 1,
                  endVal: 0,
                  durationSeconds: durationSec,
                  interp: interpToNative(auto.interpolation),
                });
                // Schedule actual stop after fade
                setTimeout(() => {
                  window.djRpc?.request?.stop?.({ trackId });
                  usePlayerStore.getState().setPlaying(trackId, false);
                  // Restore volume for next play
                  window.djRpc?.request?.setVolume?.({ trackId, volume: trackState?.volume ?? 1 });
                }, durationSec * 1000 + 50);
              } else {
                window.djRpc?.request?.stop?.({ trackId });
                usePlayerStore.getState().setPlaying(trackId, false);
              }
              break;
            }

            case "loop": {
              const loopBeats = auto.endValue > 0 ? auto.endValue : 16;
              const beatDuration = 60 / bpm;
              const loopLen = loopBeats * beatDuration;
              window.djRpc?.request?.setLoop?.({
                trackId,
                startSec: cue.time,
                endSec: cue.time + loopLen,
              });
              break;
            }

            case "filter": {
              const durationSec = auto.durationBars > 0 ? barsToSeconds(auto.durationBars, bpm) : 0;
              // startValue/endValue are 0..1 (0=full LP, 0.5=bypass, 1=full HP)
              window.djRpc?.request?.setAutomation?.({
                trackId,
                param: DJ_PARAM_FILTER,
                startVal: auto.startValue,
                endVal: auto.endValue,
                durationSeconds: durationSec,
                interp: interpToNative(auto.interpolation),
              });
              break;
            }

            case "eq_lo":
            case "eq_mid":
            case "eq_hi": {
              const durationSec = auto.durationBars > 0 ? barsToSeconds(auto.durationBars, bpm) : 0;
              const paramMap: Record<string, number> = { eq_lo: DJ_PARAM_EQ_LO, eq_mid: DJ_PARAM_EQ_MID, eq_hi: DJ_PARAM_EQ_HI };
              window.djRpc?.request?.setAutomation?.({
                trackId,
                param: paramMap[auto.type]!,
                startVal: auto.startValue,
                endVal: auto.endValue,
                durationSeconds: durationSec,
                interp: interpToNative(auto.interpolation),
              });
              break;
            }
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
