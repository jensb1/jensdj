import { create } from "zustand";
import type { TrackMetadata } from "../../shared/types.ts";

interface LibraryStore {
  tracks: TrackMetadata[];
  query: string;
  sortBy: string;
  sortDir: "asc" | "desc";
  scanning: boolean;
  scanProgress: { current: number; total: number; file: string } | null;

  setQuery: (query: string) => void;
  setSort: (sortBy: string, sortDir: "asc" | "desc") => void;
  setTracks: (tracks: TrackMetadata[]) => void;
  setScanning: (scanning: boolean) => void;
  setScanProgress: (progress: { current: number; total: number; file: string } | null) => void;
}

export const useLibraryStore = create<LibraryStore>((set) => ({
  tracks: [],
  query: "",
  sortBy: "title",
  sortDir: "asc",
  scanning: false,
  scanProgress: null,

  setQuery: (query) => set({ query }),
  setSort: (sortBy, sortDir) => set({ sortBy, sortDir }),
  setTracks: (tracks) => set({ tracks }),
  setScanning: (scanning) => set({ scanning }),
  setScanProgress: (scanProgress) => set({ scanProgress }),
}));
