import { useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import type { TrackMetadata } from "../../../shared/types.ts";

interface TrackTableProps {
  tracks: TrackMetadata[];
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  onDoubleClick: (track: TrackMetadata) => void;
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function TrackTable({ tracks, sorting, onSortingChange, onDoubleClick }: TrackTableProps) {
  const columns = useMemo<ColumnDef<TrackMetadata>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Title",
        size: 280,
        cell: (info) => (
          <span className="truncate block" title={info.getValue<string>()}>
            {info.getValue<string>() || "Unknown"}
          </span>
        ),
      },
      {
        accessorKey: "artist",
        header: "Artist",
        size: 200,
        cell: (info) => (
          <span className="truncate block" title={info.getValue<string>()}>
            {info.getValue<string>() || "Unknown"}
          </span>
        ),
      },
      {
        accessorKey: "album",
        header: "Album",
        size: 180,
        cell: (info) => (
          <span className="truncate block text-zinc-500" title={info.getValue<string>()}>
            {info.getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: "bpm",
        header: "BPM",
        size: 60,
        cell: (info) => {
          const val = info.getValue<number>();
          return val > 0 ? val.toFixed(0) : "";
        },
      },
      {
        accessorKey: "genre",
        header: "Genre",
        size: 100,
        cell: (info) => (
          <span className="truncate block text-zinc-500">
            {info.getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: "duration",
        header: "Time",
        size: 60,
        cell: (info) => {
          const val = info.getValue<number>();
          return val > 0 ? formatDuration(val) : "";
        },
      },
    ],
    []
  );

  const table = useReactTable({
    data: tracks,
    columns,
    state: { sorting },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      onSortingChange(next);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-zinc-900 z-10">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => (
                <th
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                  className="text-left px-2 py-1.5 text-zinc-500 font-semibold tracking-wide uppercase cursor-pointer select-none hover:text-zinc-300 border-b border-zinc-800"
                  style={{ width: header.getSize() }}
                >
                  <span className="flex items-center gap-1">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{ asc: " \u25B2", desc: " \u25BC" }[header.column.getIsSorted() as string] ?? ""}
                  </span>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              onDoubleClick={() => onDoubleClick(row.original)}
              className="hover:bg-zinc-800/60 cursor-default transition-colors"
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className="px-2 py-1 text-zinc-300 border-b border-zinc-800/30"
                  style={{ width: cell.column.getSize(), maxWidth: cell.column.getSize() }}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {tracks.length === 0 && (
        <div className="flex items-center justify-center h-32 text-zinc-600 text-xs">
          No tracks in library. Add a folder to scan.
        </div>
      )}
    </div>
  );
}
