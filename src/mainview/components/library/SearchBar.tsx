import { useRef, useCallback } from "react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function SearchBar({ value, onChange }: SearchBarProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onChange(v), 200);
    },
    [onChange]
  );

  return (
    <input
      type="text"
      defaultValue={value}
      onChange={handleInput}
      placeholder="Search library..."
      className="h-7 px-2 text-[11px] bg-zinc-800 text-zinc-300 border border-zinc-700 rounded placeholder-zinc-600 focus:border-indigo-500 focus:outline-none w-56"
    />
  );
}
