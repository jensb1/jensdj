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

  if (!hoveredCueId) return null;

  const hoveredCue = cues.get(hoveredCueId);
  if (!hoveredCue?.connectedCueId) return null;

  const connectedCue = cues.get(hoveredCue.connectedCueId);
  if (!connectedCue) return null;

  const layout1 = trackLayouts.get(hoveredCue.trackId);
  const layout2 = trackLayouts.get(connectedCue.trackId);
  if (!layout1 || !layout2) return null;

  const x1 = layout1.left + (hoveredCue.time / layout1.duration) * layout1.width;
  const y1 = layout1.top + layout1.height / 2;
  const x2 = layout2.left + (connectedCue.time / layout2.duration) * layout2.width;
  const y2 = layout2.top + layout2.height / 2;
  const cy1 = y1 + (y2 - y1) * 0.3;
  const cy2 = y1 + (y2 - y1) * 0.7;

  return (
    <svg className="absolute inset-0 pointer-events-none z-20" style={{ overflow: "visible" }}>
      <path
        d={`M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`}
        fill="none"
        stroke={hoveredCue.color}
        strokeWidth={2}
        strokeDasharray="4 2"
        opacity={0.8}
      />
      <circle cx={x1} cy={y1} r={4} fill={hoveredCue.color} opacity={0.9} />
      <circle cx={x2} cy={y2} r={4} fill={connectedCue.color} opacity={0.9} />
    </svg>
  );
}
