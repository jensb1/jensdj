import { useRef, useEffect } from "react";

interface LevelMeterProps {
  trackId: string;
}

export function LevelMeter({ trackId }: LevelMeterProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);
  const peakLevel = useRef(0);
  const peakDecay = useRef(0);

  useEffect(() => {
    const handler = (e: Event) => {
      const { trackId: tid, level } = (e as CustomEvent).detail;
      if (tid !== trackId) return;

      const db = level > 0 ? Math.max(0, 1 + Math.log10(level) / 2) : 0; // rough dB mapping to 0-1
      const pct = Math.min(1, db);

      if (barRef.current) {
        barRef.current.style.width = `${pct * 100}%`;
        // Color: green -> yellow -> red
        if (pct > 0.85) barRef.current.style.backgroundColor = "rgb(239, 68, 68)";
        else if (pct > 0.6) barRef.current.style.backgroundColor = "rgb(250, 204, 21)";
        else barRef.current.style.backgroundColor = "rgb(34, 197, 94)";
      }

      // Peak hold
      if (pct > peakLevel.current) {
        peakLevel.current = pct;
        peakDecay.current = 30; // hold for ~30 frames
      } else if (peakDecay.current > 0) {
        peakDecay.current--;
      } else {
        peakLevel.current = Math.max(0, peakLevel.current - 0.01);
      }

      if (peakRef.current) {
        peakRef.current.style.left = `${peakLevel.current * 100}%`;
        peakRef.current.style.opacity = peakLevel.current > 0.01 ? "1" : "0";
      }
    };
    window.addEventListener("dj:playbackTick", handler);
    return () => window.removeEventListener("dj:playbackTick", handler);
  }, [trackId]);

  return (
    <div className="w-16 h-2 bg-zinc-800 rounded-sm overflow-hidden relative">
      <div
        ref={barRef}
        className="absolute inset-y-0 left-0 rounded-sm transition-none"
        style={{ width: "0%", backgroundColor: "rgb(34, 197, 94)" }}
      />
      <div
        ref={peakRef}
        className="absolute top-0 bottom-0 w-px bg-white/80"
        style={{ left: "0%", opacity: 0 }}
      />
    </div>
  );
}
