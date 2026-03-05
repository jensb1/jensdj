import { create } from "zustand";

interface DragState {
  sourceTrackId: string;
  sourceBeatTime: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface BeatDragStore {
  drag: DragState | null;
  startDrag: (state: Omit<DragState, "currentX" | "currentY">) => void;
  updateDrag: (x: number, y: number) => void;
  endDrag: () => DragState | null;
}

export const useBeatDragStore = create<BeatDragStore>((set, get) => ({
  drag: null,

  startDrag: (state) =>
    set({
      drag: { ...state, currentX: state.startX, currentY: state.startY },
    }),

  updateDrag: (x, y) =>
    set((s) => (s.drag ? { drag: { ...s.drag, currentX: x, currentY: y } } : s)),

  endDrag: () => {
    const drag = get().drag;
    set({ drag: null });
    return drag;
  },
}));
