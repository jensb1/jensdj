import { create } from "zustand";

export interface BeatConnection {
  id: string;
  sourceTrackId: string;
  sourceBeatTime: number;
  targetTrackId: string;
  targetBeatTime: number;
}

interface ConnectionStore {
  connections: BeatConnection[];
  addConnection: (conn: Omit<BeatConnection, "id">) => void;
  removeConnection: (id: string) => void;
  getConnectionsForTrack: (trackId: string) => BeatConnection[];
}

let nextId = 1;

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  connections: [],

  addConnection: (conn) =>
    set((state) => ({
      connections: [
        ...state.connections,
        { ...conn, id: `conn_${nextId++}` },
      ],
    })),

  removeConnection: (id) =>
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
    })),

  getConnectionsForTrack: (trackId) =>
    get().connections.filter(
      (c) => c.sourceTrackId === trackId || c.targetTrackId === trackId
    ),
}));
