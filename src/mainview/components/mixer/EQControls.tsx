import { useCallback, useState } from "react";

interface EQControlsProps {
  trackId: string;
}

export function EQControls({ trackId }: EQControlsProps) {
  const [eq, setEq] = useState({ lo: 1, mid: 1, hi: 1 });

  const handleChange = useCallback(
    (band: "lo" | "mid" | "hi", value: number) => {
      const next = { ...eq, [band]: value };
      setEq(next);
      window.djRpc?.request?.setEQ?.({ trackId, eq: next });
    },
    [trackId, eq]
  );

  const handleReset = useCallback(
    (band: "lo" | "mid" | "hi") => {
      handleChange(band, 1);
    },
    [handleChange]
  );

  return (
    <div className="flex items-center gap-1">
      {(["hi", "mid", "lo"] as const).map((band) => (
        <div key={band} className="flex flex-col items-center gap-0.5">
          <span className="text-[8px] text-zinc-600 uppercase font-bold">{band}</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={eq[band]}
            onChange={(e) => handleChange(band, parseFloat(e.target.value))}
            onDoubleClick={() => handleReset(band)}
            className="w-12 h-1 accent-indigo-500 cursor-pointer"
            style={{ writingMode: "horizontal-tb" }}
            title={`${band.toUpperCase()}: ${eq[band].toFixed(2)}`}
          />
        </div>
      ))}
    </div>
  );
}
