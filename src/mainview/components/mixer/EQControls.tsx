import { useCallback, useState, useRef } from "react";

// Serum-style rotary knob with arc indicator
function Knob({ value, onChange, onReset, label, color, size = 28 }: {
  value: number; // 0-2
  onChange: (v: number) => void;
  onReset: () => void;
  label: string;
  color: string;
  size?: number;
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
  const startAngle = 135;
  const totalArc = 270;
  const pct = value / 2;
  const endAngle = startAngle + pct * totalArc;
  const r = (size - 4) / 2;
  const cx = size / 2;
  const cy = size / 2;

  const arcPath = (from: number, to: number) => {
    const rad1 = (from * Math.PI) / 180;
    const rad2 = (to * Math.PI) / 180;
    const x1 = cx + r * Math.cos(rad1);
    const y1 = cy + r * Math.sin(rad1);
    const x2 = cx + r * Math.cos(rad2);
    const y2 = cy + r * Math.sin(rad2);
    const largeArc = to - from > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
  };

  // Indicator dot position
  const indRad = (endAngle * Math.PI) / 180;
  const indR = r - 3;
  const indX = cx + indR * Math.cos(indRad);
  const indY = cy + indR * Math.sin(indRad);

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
        {pct > 0.005 && (
          <path d={arcPath(startAngle, endAngle)} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" />
        )}
        {/* Center dot */}
        <circle cx={cx} cy={cy} r={2} fill="#71717a" />
        {/* Indicator dot */}
        <circle cx={indX} cy={indY} r={2} fill="#fff" />
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

  const handleChange = useCallback(
    (band: "lo" | "mid" | "hi", value: number) => {
      const next = { ...eq, [band]: value };
      setEq(next);
      window.djRpc?.request?.setEQ?.({ trackId, eq: next });
    },
    [trackId, eq]
  );

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
        />
      ))}
    </div>
  );
}
