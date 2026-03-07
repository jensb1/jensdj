import { useCueStore } from "../../stores/cueStore.ts";

interface TrackLayout {
  trackId: string;
  top: number;
  left: number;
  width: number;
  height: number;
  duration: number;
}

interface CueConnectionsProps {
  trackLayouts: Map<string, TrackLayout>;
}

export function CueConnections({ trackLayouts }: CueConnectionsProps) {
  const cues = useCueStore((s) => s.cues);
  const hoveredCueId = useCueStore((s) => s.hoveredCueId);

  // Collect all connection lines (deduplicated)
  const lines: { sourceId: string; targetId: string }[] = [];
  for (const [, cue] of cues) {
    for (const conn of cue.connections) {
      lines.push({ sourceId: cue.id, targetId: conn.cueId });
    }
  }

  if (lines.length === 0) return null;

  return (
    <svg className="absolute inset-0 pointer-events-none z-20" style={{ overflow: "visible" }}>
      {lines.map(({ sourceId, targetId }) => {
        const source = cues.get(sourceId);
        const target = cues.get(targetId);
        if (!source || !target) return null;

        const layout1 = trackLayouts.get(source.trackId);
        const layout2 = trackLayouts.get(target.trackId);
        if (!layout1 || !layout2) return null;

        const x1 = layout1.left + (source.time / layout1.duration) * layout1.width;
        const y1 = layout1.top + layout1.height / 2;
        const x2 = layout2.left + (target.time / layout2.duration) * layout2.width;
        const y2 = layout2.top + layout2.height / 2;
        const cy1 = y1 + (y2 - y1) * 0.3;
        const cy2 = y1 + (y2 - y1) * 0.7;

        const isHighlighted = hoveredCueId === sourceId || hoveredCueId === targetId;
        const isInactive = !source.active;
        const baseOpacity = isInactive ? 0.15 : isHighlighted ? 0.9 : 0.5;

        return (
          <g key={`${sourceId}-${targetId}`}>
            <path
              d={`M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`}
              fill="none"
              stroke={source.color}
              strokeWidth={isHighlighted ? 2.5 : 1.5}
              strokeDasharray="4 2"
              opacity={baseOpacity}
            />
            <circle cx={x1} cy={y1} r={isHighlighted ? 4 : 3} fill={source.color} opacity={baseOpacity} />
            <circle cx={x2} cy={y2} r={isHighlighted ? 4 : 3} fill={target.color} opacity={baseOpacity} />
          </g>
        );
      })}
    </svg>
  );
}
