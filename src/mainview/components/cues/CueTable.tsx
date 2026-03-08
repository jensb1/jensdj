import { useMemo } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";
import { useCueStore } from "../../stores/cueStore.ts";
import type { CuePoint, AutomationType, AutomationInterpolation } from "../../../shared/types.ts";

const TYPE_LABELS: Record<AutomationType, string> = {
  connect: "Connect",
  stop: "Stop",
  loop: "Loop",
  filter: "Filter",
  eq_lo: "EQ Lo",
  eq_mid: "EQ Mid",
  eq_hi: "EQ Hi",
};

const TYPE_OPTIONS: { value: AutomationType; label: string }[] = [
  { value: "filter", label: "Filter" },
  { value: "eq_lo", label: "EQ Lo" },
  { value: "eq_mid", label: "EQ Mid" },
  { value: "eq_hi", label: "EQ Hi" },
  { value: "stop", label: "Stop" },
  { value: "loop", label: "Loop" },
];

const INTERP_OPTIONS: { value: AutomationInterpolation; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "easeIn", label: "Ease In" },
  { value: "easeOut", label: "Ease Out" },
];

function formatCueTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
}

// Types that support duration & interpolation
function hasDuration(type: AutomationType): boolean {
  return type === "filter" || type === "eq_lo" || type === "eq_mid" || type === "eq_hi" || type === "stop";
}

export function CueTable() {
  const selectedTrackId = usePlayerStore((s) => s.selectedTrackId);
  const tracks = usePlayerStore((s) => s.tracks);
  const cuesMap = useCueStore((s) => s.cues);
  const toggleActive = useCueStore((s) => s.toggleActive);
  const removeCue = useCueStore((s) => s.removeCue);
  const addOrToggleCue = useCueStore((s) => s.addOrToggleCue);
  const addAutomation = useCueStore((s) => s.addAutomation);
  const removeAutomation = useCueStore((s) => s.removeAutomation);
  const updateAutomation = useCueStore((s) => s.updateAutomation);
  const selectedCueId = useCueStore((s) => s.selectedCueId);
  const setSelectedCueId = useCueStore((s) => s.setSelectedCueId);

  const selectedTrack = selectedTrackId ? tracks.get(selectedTrackId) : null;

  const trackCues = useMemo(() => {
    if (!selectedTrackId) return [];
    const result: CuePoint[] = [];
    for (const cue of cuesMap.values()) {
      if (cue.trackId === selectedTrackId) result.push(cue);
    }
    return result.sort((a, b) => a.time - b.time);
  }, [cuesMap, selectedTrackId]);

  const allCuesMap = cuesMap;

  if (!selectedTrackId || !selectedTrack) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-600 text-[11px]">
        Select a track to view cues
      </div>
    );
  }

  const handleAddCue = () => {
    const pos = selectedTrack.lockedPosition ?? selectedTrack.previewPosition ?? selectedTrack.position;
    addOrToggleCue(selectedTrackId, selectedTrack.track.filePath, pos, selectedTrack.track.beats);
  };

  const handleSeekToCue = (cue: CuePoint) => {
    usePlayerStore.getState().setLockedPosition(selectedTrackId, cue.time);
    usePlayerStore.getState().setPreviewPosition(selectedTrackId, cue.time);
  };

  const handleAddAutomation = (cueId: string, type: AutomationType) => {
    // Sensible defaults per type
    const defaults: Record<string, { start: number; end: number; bars: number }> = {
      filter: { start: 0.5, end: 0, bars: 4 },     // bypass → full LP
      eq_lo: { start: 1, end: 0, bars: 4 },         // unity → kill
      eq_mid: { start: 1, end: 0, bars: 4 },
      eq_hi: { start: 1, end: 0, bars: 4 },
      stop: { start: 1, end: 0, bars: 4 },          // fade out
      loop: { start: 0, end: 16, bars: 0 },            // 16 beats = 4 bars
    };
    const d = defaults[type] ?? { start: 0, end: 1, bars: 4 };
    addAutomation(cueId, {
      id: crypto.randomUUID(),
      type,
      durationBars: d.bars,
      interpolation: "linear",
      startValue: d.start,
      endValue: d.end,
    });
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider shrink-0">Cues</span>
          <span className="text-[10px] text-zinc-500 truncate">
            {selectedTrack.track.metadata.title}
          </span>
        </div>
        <button
          onClick={handleAddCue}
          className="px-2 py-0.5 text-[9px] font-bold uppercase rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-700/50 hover:border-zinc-500 shrink-0"
        >
          + CUE
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {trackCues.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-[10px]">
            No cues yet
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/30">
            {trackCues.map((cue) => {
              const isExpanded = selectedCueId === cue.id;
              const nonConnectAutos = cue.automations.filter(a => a.type !== "connect");
              const connectAutos = cue.automations.filter(a => a.type === "connect");

              return (
                <div key={cue.id}>
                  {/* Cue row */}
                  <div
                    className="flex items-center gap-1 px-2 py-1 hover:bg-zinc-800/30 cursor-pointer text-[10px]"
                    onClick={() => handleSeekToCue(cue)}
                  >
                    {/* Expand toggle */}
                    <button
                      className="text-zinc-500 hover:text-zinc-300 w-3 text-[8px] shrink-0"
                      onClick={(e) => { e.stopPropagation(); setSelectedCueId(isExpanded ? null : cue.id); }}
                    >
                      {isExpanded ? "\u25BC" : "\u25B6"}
                    </button>

                    {/* Label */}
                    <span
                      className="inline-block px-1.5 py-px rounded text-[9px] font-bold font-mono shrink-0"
                      style={{ backgroundColor: cue.color + "30", color: cue.color }}
                    >
                      {cue.label}
                    </span>

                    {/* Time */}
                    <span className="font-mono text-zinc-300 w-14 shrink-0">
                      {formatCueTime(cue.time)}
                    </span>

                    {/* Active toggle */}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleActive(cue.id); }}
                      className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                        cue.active
                          ? "border-emerald-400 bg-emerald-400/20"
                          : "border-zinc-600 bg-transparent hover:border-zinc-400"
                      }`}
                      title={cue.active ? "Deactivate" : "Activate"}
                    >
                      {cue.active && <span className="text-emerald-400 text-[7px] leading-none block">●</span>}
                    </button>

                    {/* Summary */}
                    <span className="text-zinc-500 truncate flex-1 text-[9px]">
                      {connectAutos.map(a => {
                        const t = a.targetCueId ? allCuesMap.get(a.targetCueId) : null;
                        return t ? `→${t.label}` : null;
                      }).filter(Boolean).join(" ")}
                      {nonConnectAutos.length > 0 && (
                        <span className="text-amber-400/60 ml-1">
                          {nonConnectAutos.map(a => TYPE_LABELS[a.type]).join(", ")}
                        </span>
                      )}
                    </span>

                    {/* Delete */}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeCue(cue.id); }}
                      className="text-zinc-600 hover:text-red-400 text-[10px] shrink-0"
                      title="Delete cue"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Expanded automation editor */}
                  {isExpanded && (
                    <div className="bg-zinc-900/50 px-4 py-1.5 space-y-1">
                      {/* Existing automations */}
                      {cue.automations.map((auto) => (
                        <div key={auto.id} className="flex items-center gap-2 text-[9px]">
                          {/* Type label */}
                          <span className="text-amber-300 w-16 shrink-0 font-medium">
                            {auto.type === "connect" && auto.targetCueId
                              ? `→ ${allCuesMap.get(auto.targetCueId)?.label ?? "?"}`
                              : TYPE_LABELS[auto.type]}
                          </span>

                          {/* Filter direction */}
                          {auto.type === "filter" && (
                            <select
                              className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[9px] text-zinc-300"
                              value={auto.endValue < 0.25 ? "lp" : auto.endValue > 0.75 ? "hp" : "lp"}
                              onChange={(e) => {
                                e.stopPropagation();
                                if (e.target.value === "lp") {
                                  updateAutomation(cue.id, auto.id, { startValue: 0.5, endValue: 0 });
                                } else {
                                  updateAutomation(cue.id, auto.id, { startValue: 0.5, endValue: 1 });
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <option value="lp">→ LP</option>
                              <option value="hp">→ HP</option>
                            </select>
                          )}

                          {/* EQ target */}
                          {(auto.type === "eq_lo" || auto.type === "eq_mid" || auto.type === "eq_hi") && (
                            <select
                              className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[9px] text-zinc-300"
                              value={auto.endValue < 0.5 ? "kill" : auto.endValue > 1.5 ? "boost" : "kill"}
                              onChange={(e) => {
                                e.stopPropagation();
                                if (e.target.value === "kill") {
                                  updateAutomation(cue.id, auto.id, { startValue: 1, endValue: 0 });
                                } else {
                                  updateAutomation(cue.id, auto.id, { startValue: 1, endValue: 2 });
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <option value="kill">→ Kill</option>
                              <option value="boost">→ Boost</option>
                            </select>
                          )}

                          {/* Loop length: bars + beats with ×2/÷2 */}
                          {auto.type === "loop" && (() => {
                            const totalBeats = auto.endValue > 0 ? auto.endValue : 16;
                            const bars = Math.floor(totalBeats / 4);
                            const extraBeats = Math.round(totalBeats % 4);
                            return (
                              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                <button
                                  className="px-1 py-0.5 text-[8px] rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
                                  onClick={() => {
                                    const half = Math.max(1, Math.round(totalBeats / 2));
                                    updateAutomation(cue.id, auto.id, { endValue: half });
                                  }}
                                >÷2</button>
                                <select
                                  className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[9px] text-zinc-300 w-12"
                                  value={bars}
                                  onChange={(e) => updateAutomation(cue.id, auto.id, { endValue: Number(e.target.value) * 4 + extraBeats })}
                                >
                                  {[0,1,2,4,8,16,32].map(b => <option key={b} value={b}>{b} bar{b !== 1 ? "s" : ""}</option>)}
                                </select>
                                <select
                                  className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[9px] text-zinc-300 w-10"
                                  value={extraBeats}
                                  onChange={(e) => updateAutomation(cue.id, auto.id, { endValue: bars * 4 + Number(e.target.value) })}
                                >
                                  {[0,1,2,3].map(b => <option key={b} value={b}>{b} bt</option>)}
                                </select>
                                <button
                                  className="px-1 py-0.5 text-[8px] rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
                                  onClick={() => updateAutomation(cue.id, auto.id, { endValue: totalBeats * 2 })}
                                >×2</button>
                              </div>
                            );
                          })()}

                          {/* Duration */}
                          {hasDuration(auto.type) && (
                            <select
                              className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[9px] text-zinc-300"
                              value={auto.durationBars}
                              onChange={(e) => {
                                e.stopPropagation();
                                updateAutomation(cue.id, auto.id, { durationBars: Number(e.target.value) });
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <option value={0}>Instant</option>
                              <option value={1}>1 bar</option>
                              <option value={2}>2 bars</option>
                              <option value={4}>4 bars</option>
                              <option value={8}>8 bars</option>
                              <option value={16}>16 bars</option>
                            </select>
                          )}

                          {/* Interpolation */}
                          {hasDuration(auto.type) && auto.durationBars > 0 && (
                            <select
                              className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[9px] text-zinc-300"
                              value={auto.interpolation}
                              onChange={(e) => {
                                e.stopPropagation();
                                updateAutomation(cue.id, auto.id, { interpolation: e.target.value as AutomationInterpolation });
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {INTERP_OPTIONS.map(o => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          )}

                          {/* Delete */}
                          <button
                            className="text-zinc-600 hover:text-red-400 ml-auto"
                            onClick={(e) => { e.stopPropagation(); removeAutomation(cue.id, auto.id); }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}

                      {/* Add automation button */}
                      <div className="flex items-center gap-1 pt-0.5">
                        <span className="text-[9px] text-zinc-600">Add:</span>
                        {TYPE_OPTIONS.map(opt => {
                          // Don't allow duplicates for non-connect types
                          const exists = cue.automations.some(a => a.type === opt.value);
                          if (exists) return null;
                          return (
                            <button
                              key={opt.value}
                              className="px-1.5 py-0.5 text-[8px] rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
                              onClick={(e) => { e.stopPropagation(); handleAddAutomation(cue.id, opt.value); }}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
