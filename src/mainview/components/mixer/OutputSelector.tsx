import { useCallback } from "react";
import { usePlayerStore } from "../../stores/playerStore.ts";

interface OutputSelectorProps {
  trackId: string;
  currentDeviceId: number;
}

export function OutputSelector({ trackId, currentDeviceId }: OutputSelectorProps) {
  const devices = usePlayerStore((s) => s.devices);
  const setDeviceId = usePlayerStore((s) => s.setDeviceId);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const deviceId = parseInt(e.target.value, 10);
      setDeviceId(trackId, deviceId);
      window.djRpc?.request?.setOutputDevice?.({ trackId, deviceId });
    },
    [trackId, setDeviceId]
  );

  if (devices.length === 0) return null;

  return (
    <select
      value={currentDeviceId}
      onChange={handleChange}
      className="h-7 px-1.5 text-[10px] font-mono bg-zinc-800 text-zinc-400 border border-zinc-700 rounded cursor-pointer hover:border-zinc-600 focus:border-indigo-500 focus:outline-none truncate max-w-[120px]"
    >
      <option value={-1}>Default</option>
      {devices.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name} ({d.channels}ch)
        </option>
      ))}
    </select>
  );
}
