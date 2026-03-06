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
  allowTransportPreserve?: boolean;
}

export interface SyncStartPlan {
  sourceBeat: number;
  targetBeat: number;
  barDuration: number;
  preserveTransport: boolean;
}

export interface CueSyncStartPlanInput {
  source: SyncPlanTrack;
  sourceCueTime: number;
  targetCueTime: number;
}

export interface ScheduledSyncPlan {
  sourceBeat: number;
  targetBeat: number;
}

const BEAT_SNAP_WINDOW_SEC = 0.12;

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

export function findNearestBeat(beats: number[], position: number): { beat: number; index: number } {
  let bestBeat = beats[0] ?? 0;
  let bestIndex = 0;
  let minDist = Infinity;
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i] ?? 0;
    const dist = Math.abs(beat - position);
    if (dist < minDist) {
      minDist = dist;
      bestBeat = beat;
      bestIndex = i;
    }
  }
  return { beat: bestBeat, index: bestIndex };
}

export function findNearestPhaseMatchedBeat(
  beats: number[],
  position: number,
  phaseIndex: number
): { beat: number; index: number } {
  let bestBeat = beats[phaseIndex] ?? beats[0] ?? 0;
  let bestIndex = phaseIndex;
  let minDist = Infinity;

  for (let i = phaseIndex; i < beats.length; i += 4) {
    const beat = beats[i] ?? 0;
    const dist = Math.abs(beat - position);
    if (dist < minDist) {
      minDist = dist;
      bestBeat = beat;
      bestIndex = i;
    }
  }

  return { beat: bestBeat, index: bestIndex };
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
    input.allowTransportPreserve !== false &&
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

export function buildCueSyncStartPlan(input: CueSyncStartPlanInput): SyncStartPlan | null {
  const { source, sourceCueTime, targetCueTime } = input;
  if (!Number.isFinite(sourceCueTime) || !Number.isFinite(targetCueTime)) return null;

  return {
    sourceBeat: sourceCueTime,
    targetBeat: targetCueTime,
    barDuration: getBarDuration(source.beats),
    preserveTransport: false,
  };
}

export function buildScheduledBeatSyncPlan(input: SyncPlanInput): ScheduledSyncPlan | null {
  const { source, target, sourcePos } = input;
  if (source.beats.length < 5 || target.beats.length < 5) return null;

  const targetStartPos = resolveTargetStartPosition(input);
  const targetBeatMatch = findNearestBeat(target.beats, targetStartPos);
  if (Math.abs(targetBeatMatch.beat - targetStartPos) > BEAT_SNAP_WINDOW_SEC) {
    return null;
  }
  const phaseIndex = targetBeatMatch.index % 4;
  const sourceBeatMatch = findNearestPhaseMatchedBeat(source.beats, sourcePos, phaseIndex);

  return {
    sourceBeat: sourceBeatMatch.beat,
    targetBeat: targetBeatMatch.beat,
  };
}
