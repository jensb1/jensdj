export interface SyncPlanTrack {
  beats: number[];
  filePath: string;
}

export interface SyncPlanInput {
  source: SyncPlanTrack;
  target: SyncPlanTrack;
  sourcePos: number;
  targetPos: number;
  targetAnchorPos?: number | null;
}

export interface SyncStartPlan {
  sourceBeat: number;
  targetBeat: number;
  barDuration: number;
  preserveTransport: boolean;
}

function normalizePhase(offset: number, barDuration: number): number {
  if (barDuration <= 0) return 0;
  let phase = offset % barDuration;
  if (phase < 0) phase += barDuration;
  return phase;
}

function resolveTargetStartPosition(input: SyncPlanInput): number {
  if (typeof input.targetAnchorPos === "number" && Number.isFinite(input.targetAnchorPos)) {
    return input.targetAnchorPos;
  }
  return input.targetPos;
}

export function findNearestDownbeat(beats: number[], position: number): number {
  let best = beats[0] ?? 0;
  let minDist = Infinity;
  for (let i = 0; i < beats.length; i += 4) {
    const beat = beats[i] ?? 0;
    const dist = Math.abs(beat - position);
    if (dist < minDist) {
      minDist = dist;
      best = beat;
    }
  }
  return best;
}

export function findCurrentDownbeat(beats: number[], position: number): number {
  const firstBeat = beats[0] ?? 0;
  let best = firstBeat;
  for (let i = 0; i < beats.length; i += 4) {
    const beat = beats[i] ?? firstBeat;
    if (beat > position + 0.01) break;
    best = beat;
  }
  return best;
}

export function findPhaseAlignedDownbeat(
  beats: number[],
  targetPos: number,
  sourcePhase: number
): number {
  let bestBeat = beats[0] ?? 0;
  let bestDistance = Infinity;

  for (let i = 0; i < beats.length; i += 4) {
    const beat = beats[i] ?? 0;
    const alignedPos = beat + sourcePhase;
    const distance = Math.abs(alignedPos - targetPos);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestBeat = beat;
    }
  }

  return bestBeat;
}

export function getBarDuration(beats: number[]): number {
  if (beats.length < 5) return 2.0;
  const intervals: number[] = [];
  for (let i = 0; i + 4 < beats.length && intervals.length < 8; i += 4) {
    intervals.push((beats[i + 4] ?? 0) - (beats[i] ?? 0));
  }
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)] ?? 2.0;
}

function createPlan(
  input: SyncPlanInput,
  pickTargetBeat: (beats: number[], position: number) => number
): SyncStartPlan | null {
  const { source, target } = input;
  if (source.beats.length < 5 || target.beats.length < 5) return null;

  const targetStartPos = resolveTargetStartPosition(input);
  const sourceBeat = source.beats[0] ?? 0;
  const targetBeat = pickTargetBeat(target.beats, targetStartPos);
  const firstTargetBeat = target.beats[0] ?? 0;

  return {
    sourceBeat,
    targetBeat,
    barDuration: getBarDuration(source.beats),
    preserveTransport:
      source.filePath === target.filePath &&
      targetStartPos <= firstTargetBeat + 0.1,
  };
}

export function buildLegacySyncStartPlan(input: SyncPlanInput): SyncStartPlan | null {
  return createPlan(input, findNearestDownbeat);
}

export function buildSyncStartPlan(input: SyncPlanInput): SyncStartPlan | null {
  const { source, target, sourcePos } = input;
  if (source.beats.length < 5 || target.beats.length < 5) return null;

  const targetStartPos = resolveTargetStartPosition(input);
  const sourceBeat = source.beats[0] ?? 0;
  const barDuration = getBarDuration(source.beats);
  const sourcePhase = normalizePhase(sourcePos - sourceBeat, barDuration);
  const firstTargetBeat = target.beats[0] ?? 0;
  const preserveTransport =
    source.filePath === target.filePath &&
    targetStartPos <= firstTargetBeat + 0.1;

  return {
    sourceBeat,
    targetBeat: preserveTransport
      ? firstTargetBeat
      : findPhaseAlignedDownbeat(target.beats, targetStartPos, sourcePhase),
    barDuration,
    preserveTransport,
  };
}
