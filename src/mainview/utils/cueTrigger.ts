export const CUE_TRIGGER_WINDOW_SEC = 0.05;
export const CUE_REARM_WINDOW_SEC = 0.10;

export function shouldRearmCue(position: number, cueTime: number): boolean {
  return position < cueTime - CUE_REARM_WINDOW_SEC;
}

export function hasCrossedCue(previousPosition: number | undefined, position: number, cueTime: number): boolean {
  if (previousPosition === undefined) {
    return Math.abs(position - cueTime) <= CUE_TRIGGER_WINDOW_SEC;
  }
  if (position < previousPosition - CUE_REARM_WINDOW_SEC) {
    return false;
  }
  return previousPosition < cueTime - CUE_TRIGGER_WINDOW_SEC && position >= cueTime - CUE_TRIGGER_WINDOW_SEC;
}
