import { useCallback, useState, useRef, useEffect } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";

// Serum-style rotary knob with arc indicator
function Knob({ value, onChange, onReset, label, color, size = 28, automationActive = false }: {
  value: number; // 0-2
  onChange: (v: number) => void;
  onReset: () => void;
  label: string;
  color: string;
  size?: number;
  automationActive?: boolean;
}) {
  const dragRef = useRef<{ startY: number; startVal: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startVal: value };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - ev.clientY;
      const newVal = Math.max(0, Math.min(2, dragRef.current.startVal + dy * 0.01));
      onChange(newVal);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [value, onChange]);

  // Arc: 270° range, from 135° (7 o'clock) to 405° (5 o'clock)
  // Center (unity=1) is at 270° (12 o'clock)
  const startAngle = 135;
  const totalArc = 270;
  const centerAngle = startAngle + totalArc / 2; // 270° = 12 o'clock
  const pct = value / 2; // 0..1 where 0.5 = center
  const valueAngle = startAngle + pct * totalArc;
  const r = (size - 4) / 2;
  const cx = size / 2;
  const cy = size / 2;

  const arcPath = (from: number, to: number) => {
    if (Math.abs(to - from) < 0.5) return "";
    const rad1 = (from * Math.PI) / 180;
    const rad2 = (to * Math.PI) / 180;
    const x1 = cx + r * Math.cos(rad1);
    const y1 = cy + r * Math.sin(rad1);
    const x2 = cx + r * Math.cos(rad2);
    const y2 = cy + r * Math.sin(rad2);
    const largeArc = Math.abs(to - from) > 180 ? 1 : 0;
    const sweep = to > from ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} ${sweep} ${x2} ${y2}`;
  };

  // Indicator dot position
  const indRad = (valueAngle * Math.PI) / 180;
  const indR = r - 3;
  const indX = cx + indR * Math.cos(indRad);
  const indY = cy + indR * Math.sin(indRad);

  // Center tick mark (12 o'clock)
  const centerRad = (centerAngle * Math.PI) / 180;
  const tickInner = r - 1;
  const tickOuter = r + 1;

  const arcColor = automationActive ? "#f59e0b" : (value < 0.98 ? "#ef4444" : value > 1.02 ? "#eab308" : color);

  return (
    <div
      className="flex flex-col items-center cursor-ns-resize select-none"
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      title={`${label}: ${value.toFixed(2)}`}
    >
      <span className="text-[7px] text-zinc-500 font-bold uppercase leading-none">{label}</span>
      <svg width={size} height={size}>
        {/* Background arc */}
        <path d={arcPath(startAngle, startAngle + totalArc)} fill="none" stroke="#3f3f46" strokeWidth={3} strokeLinecap="round" />
        {/* Value arc */}
        {value < 0.98 && (
          <path d={arcPath(valueAngle, centerAngle)} fill="none" stroke={arcColor} strokeWidth={3} strokeLinecap="round" />
        )}
        {value > 1.02 && (
          <path d={arcPath(centerAngle, valueAngle)} fill="none" stroke={arcColor} strokeWidth={3} strokeLinecap="round" />
        )}
        {/* Automation pulse ring */}
        {automationActive && (
          <circle cx={cx} cy={cy} r={r + 1} fill="none" stroke="#f59e0b" strokeWidth={1} opacity={0.5}>
            <animate attributeName="opacity" values="0.5;1;0.5" dur="0.8s" repeatCount="indefinite" />
          </circle>
        )}
        {/* Center tick */}
        <line
          x1={cx + tickInner * Math.cos(centerRad)}
          y1={cy + tickInner * Math.sin(centerRad)}
          x2={cx + tickOuter * Math.cos(centerRad)}
          y2={cy + tickOuter * Math.sin(centerRad)}
          stroke="#71717a" strokeWidth={1}
        />
        {/* Center dot */}
        <circle cx={cx} cy={cy} r={2} fill="#71717a" />
        {/* Indicator dot */}
        <circle cx={indX} cy={indY} r={2} fill={automationActive ? "#f59e0b" : "#fff"} />
      </svg>
    </div>
  );
}

interface EQControlsProps {
  trackId: string;
  layout?: "horizontal" | "vertical";
}

export function EQControls({ trackId, layout = "horizontal" }: EQControlsProps) {
  const [eq, setEq] = useState({ lo: 1, mid: 1, hi: 1 });
  const [filter, setFilter] = useState(0.5); // 0=LP, 0.5=bypass, 1=HP

  // Read automation state from player store
  const filterAutoActive = usePlayerStore((s) => s.tracks.get(trackId)?.filterAutomationActive ?? false);
  const storeFilterValue = usePlayerStore((s) => s.tracks.get(trackId)?.filterValue ?? 0.5);
  const eqAutoActive = usePlayerStore((s) => s.tracks.get(trackId)?.eqAutomationActive ?? false);
  const storeEqLo = usePlayerStore((s) => s.tracks.get(trackId)?.eqLo ?? 1);
  const storeEqMid = usePlayerStore((s) => s.tracks.get(trackId)?.eqMid ?? 1);
  const storeEqHi = usePlayerStore((s) => s.tracks.get(trackId)?.eqHi ?? 1);

  // When automation is active, reflect C engine values in knobs
  useEffect(() => {
    if (filterAutoActive) {
      setFilter(storeFilterValue);
    }
  }, [filterAutoActive, storeFilterValue]);

  useEffect(() => {
    if (eqAutoActive) {
      setEq({ lo: storeEqLo, mid: storeEqMid, hi: storeEqHi });
    }
  }, [eqAutoActive, storeEqLo, storeEqMid, storeEqHi]);

  const handleChange = useCallback(
    (band: "lo" | "mid" | "hi", value: number) => {
      const next = { ...eq, [band]: value };
      setEq(next);
      window.djRpc?.request?.setEQ?.({ trackId, eq: next });
    },
    [trackId, eq]
  );

  const handleFilterChange = useCallback(
    (value: number) => {
      // value is 0..2 from Knob, map to 0..1 for DJ filter
      const filterVal = value / 2;
      setFilter(filterVal);
      window.djRpc?.request?.setFilter?.({ trackId, value: filterVal });
    },
    [trackId]
  );

  // Sync from MIDI EQ changes
  useEffect(() => {
    const handler = (e: Event) => {
      const { action, trackId: tid, value, band } = (e as CustomEvent).detail;
      if (tid !== trackId) return;
      if (action === "eq") {
        setEq((prev) => ({ ...prev, [band]: value }));
      } else if (action === "filter") {
        setFilter(value);
      }
    };
    window.addEventListener("dj:midiAction", handler);
    return () => window.removeEventListener("dj:midiAction", handler);
  }, [trackId]);

  const bands = [
    { key: "hi" as const, label: "HI", color: "#e8e8ff" },
    { key: "mid" as const, label: "MID", color: "#ff9500" },
    { key: "lo" as const, label: "LO", color: "#2563ff" },
  ];

  const knobSize = layout === "vertical" ? 22 : 28;

  return (
    <div className={layout === "vertical" ? "flex flex-col items-center justify-center" : "flex items-center gap-1"}>
      {bands.map(({ key, label, color }) => (
        <Knob
          key={key}
          value={eq[key]}
          onChange={(v) => handleChange(key, v)}
          onReset={() => handleChange(key, 1)}
          label={label}
          color={color}
          size={knobSize}
          automationActive={eqAutoActive}
        />
      ))}
      <Knob
        value={filter * 2} // Map 0..1 → 0..2 for knob display
        onChange={handleFilterChange}
        onReset={() => handleFilterChange(1)} // 1 = 0.5 filter = bypass
        label="FLT"
        color="#a855f7"
        size={knobSize}
        automationActive={filterAutoActive}
      />
    </div>
  );
}
