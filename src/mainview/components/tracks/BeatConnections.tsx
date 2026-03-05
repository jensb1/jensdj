import { useConnectionStore } from "../../stores/connectionStore.ts";
import { useBeatDragStore } from "../../stores/beatDragStore.ts";

interface TrackLayout {
  trackId: string;
  top: number;
  left: number;
  width: number;
  height: number;
  duration: number;
}

interface BeatConnectionsProps {
  trackLayouts: Map<string, TrackLayout>;
}

function beatToX(beatTime: number, layout: TrackLayout): number {
  return layout.left + (beatTime / layout.duration) * layout.width;
}

function trackCenterY(layout: TrackLayout): number {
  return layout.top + layout.height / 2;
}

export function BeatConnections({ trackLayouts }: BeatConnectionsProps) {
  const connections = useConnectionStore((s) => s.connections);
  const removeConnection = useConnectionStore((s) => s.removeConnection);
  const drag = useBeatDragStore((s) => s.drag);

  return (
    <svg className="absolute inset-0 pointer-events-none z-20" style={{ overflow: "visible" }}>
      {/* Existing connections */}
      {connections.map((conn) => {
        const srcLayout = trackLayouts.get(conn.sourceTrackId);
        const tgtLayout = trackLayouts.get(conn.targetTrackId);
        if (!srcLayout || !tgtLayout) return null;

        const x1 = beatToX(conn.sourceBeatTime, srcLayout);
        const y1 = trackCenterY(srcLayout);
        const x2 = beatToX(conn.targetBeatTime, tgtLayout);
        const y2 = trackCenterY(tgtLayout);
        const cy1 = y1 + (y2 - y1) * 0.3;
        const cy2 = y1 + (y2 - y1) * 0.7;

        return (
          <g key={conn.id} className="pointer-events-auto cursor-pointer" onClick={() => removeConnection(conn.id)}>
            {/* Hit area (wider invisible stroke) */}
            <path
              d={`M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`}
              fill="none"
              stroke="transparent"
              strokeWidth={12}
            />
            {/* Visible line */}
            <path
              d={`M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`}
              fill="none"
              stroke="rgba(129, 140, 248, 0.6)"
              strokeWidth={2}
              strokeDasharray="4 2"
            />
            {/* Dots at endpoints */}
            <circle cx={x1} cy={y1} r={4} fill="rgba(129, 140, 248, 0.8)" />
            <circle cx={x2} cy={y2} r={4} fill="rgba(129, 140, 248, 0.8)" />
          </g>
        );
      })}

      {/* Active drag line */}
      {drag && (
        <line
          x1={drag.startX}
          y1={drag.startY}
          x2={drag.currentX}
          y2={drag.currentY}
          stroke="rgba(129, 140, 248, 0.5)"
          strokeWidth={2}
          strokeDasharray="6 3"
        />
      )}
    </svg>
  );
}
