/**
 * End-to-end sync test — uses the same native djengine library.
 * Run: bun native/test_sync.ts
 */
import { dlopen, FFIType, ptr, CString, type Pointer } from "bun:ffi";
import { resolve } from "path";

const libPath = resolve(import.meta.dir, "libdjengine.dylib");
const lib = dlopen(libPath, {
  dj_init: { returns: FFIType.i32 },
  dj_shutdown: { returns: FFIType.void },
  dj_get_device_count: { returns: FFIType.i32 },
  dj_create_engine: { args: [FFIType.i32], returns: FFIType.ptr },
  dj_destroy_engine: { args: [FFIType.ptr], returns: FFIType.void },
  dj_load_sound: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
  dj_unload_sound: { args: [FFIType.ptr], returns: FFIType.void },
  dj_play: { args: [FFIType.ptr], returns: FFIType.i32 },
  dj_pause: { args: [FFIType.ptr], returns: FFIType.i32 },
  dj_stop: { args: [FFIType.ptr], returns: FFIType.i32 },
  dj_seek: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.i32 },
  dj_get_position: { args: [FFIType.ptr], returns: FFIType.f32 },
  dj_get_duration: { args: [FFIType.ptr], returns: FFIType.f32 },
  dj_is_playing: { args: [FFIType.ptr], returns: FFIType.i32 },
  dj_set_volume: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
  dj_set_tempo: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
  dj_set_original_bpm: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void },
  dj_get_original_bpm: { args: [FFIType.ptr], returns: FFIType.f32 },
  dj_detect_bpm: { args: [FFIType.cstring], returns: FFIType.f32 },
  dj_detect_beats: { args: [FFIType.cstring, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  dj_sync_start: {
    args: [FFIType.ptr, FFIType.f32, FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.i32],
    returns: FFIType.i32,
  },
});

const s = lib.symbols;
function cstr(str: string) { return new TextEncoder().encode(str + "\0"); }

const TEST_FILE = "/Volumes/MUSIC/all/acid pauli - nana.mp3";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function legacyNearestDownbeat(beats: Float32Array, beatCount: number, position: number): number {
  let best = beats[0] ?? 0;
  let minDist = Infinity;
  for (let i = 0; i < beatCount; i += 4) {
    const beat = beats[i] ?? 0;
    const dist = Math.abs(beat - position);
    if (dist < minDist) {
      minDist = dist;
      best = beat;
    }
  }
  return best;
}

async function runTest() {
  console.log("=== DJ Sync Test ===\n");

  // Init
  const initResult = s.dj_init();
  console.log(`dj_init: ${initResult}`);
  if (initResult !== 0) { console.error("FAILED to init"); process.exit(1); }

  const deviceCount = s.dj_get_device_count();
  console.log(`Devices: ${deviceCount}`);

  // Create engine (default device)
  const engine = s.dj_create_engine(-1);
  if (!engine) { console.error("FAILED to create engine"); process.exit(1); }
  console.log("Engine created\n");

  // Detect BPM and beats
  console.log("Detecting BPM...");
  const bpm = s.dj_detect_bpm(cstr(TEST_FILE));
  console.log(`BPM: ${bpm.toFixed(1)}`);

  console.log("Detecting beats...");
  const beatBuf = new Float32Array(4000);
  const beatCount = s.dj_detect_beats(cstr(TEST_FILE), ptr(beatBuf) as Pointer, 4000);
  console.log(`Beats: ${beatCount}`);

  // Calculate bar duration
  const bars: number[] = [];
  for (let i = 0; i + 4 < beatCount && bars.length < 8; i += 4) {
    bars.push(beatBuf[i + 4]! - beatBuf[i]!);
  }
  bars.sort((a, b) => a - b);
  const barDur = bars[Math.floor(bars.length / 2)] ?? 2.0;
  const firstBeat = beatBuf[0] ?? 0;
  console.log(`First beat: ${firstBeat.toFixed(3)}s  Bar duration: ${barDur.toFixed(3)}s\n`);

  // Load two copies
  console.log("Loading track 1...");
  const snd1 = s.dj_load_sound(engine, cstr(TEST_FILE));
  if (!snd1) { console.error("FAILED to load sound 1"); process.exit(1); }
  s.dj_set_original_bpm(snd1, bpm);

  console.log("Loading track 2...");
  const snd2 = s.dj_load_sound(engine, cstr(TEST_FILE));
  if (!snd2) { console.error("FAILED to load sound 2"); process.exit(1); }
  s.dj_set_original_bpm(snd2, bpm);

  const dur = s.dj_get_duration(snd1);
  console.log(`Duration: ${dur.toFixed(1)}s\n`);

  // Mute so we don't disturb
  s.dj_set_volume(snd1, 0.0);
  s.dj_set_volume(snd2, 0.0);

  // ====== TEST 1: Both from start ======
  console.log("--- TEST 1: Both from start ---");
  s.dj_play(snd1);
  await sleep(500); // let track 1 play for 500ms

  const r1 = s.dj_sync_start(snd2, firstBeat, snd1, firstBeat, barDur, 1);
  console.log(`sync_start result: ${r1}`);

  // Sample positions for 2 seconds
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const p1 = s.dj_get_position(snd1);
    const p2 = s.dj_get_position(snd2);
    const diff = (p2 - p1) * 1000;
    console.log(`  t1=${p1.toFixed(4)} t2=${p2.toFixed(4)} diff=${diff.toFixed(1)}ms`);
  }

  s.dj_stop(snd1);
  s.dj_stop(snd2);
  await sleep(100);

  // ====== TEST 2: Track 1 playing, sync track 2 from start ======
  console.log("\n--- TEST 2: T1 playing 5s, sync T2 from start ---");
  s.dj_play(snd1);
  await sleep(5000);

  const r2 = s.dj_sync_start(snd2, firstBeat, snd1, firstBeat, barDur, 1);
  console.log(`sync_start result: ${r2}`);

  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const p1 = s.dj_get_position(snd1);
    const p2 = s.dj_get_position(snd2);
    const diff = (p2 - p1) * 1000;
    let phase = ((p2 - p1) % barDur);
    if (phase > barDur / 2) phase -= barDur;
    if (phase < -barDur / 2) phase += barDur;
    const phaseErr = Math.min(Math.abs(phase), Math.abs(barDur - Math.abs(phase))) * 1000;
    console.log(`  t1=${p1.toFixed(4)} t2=${p2.toFixed(4)} diff=${diff.toFixed(1)}ms phaseErr=${phaseErr.toFixed(1)}ms`);
  }

  s.dj_stop(snd1);
  s.dj_stop(snd2);
  await sleep(100);

  // ====== TEST 3: Stop and restart multiple times ======
  console.log("\n--- TEST 3: Stop/restart cycle (5 iterations) ---");
  s.dj_play(snd1);
  await sleep(500);

  for (let cycle = 0; cycle < 5; cycle++) {
    s.dj_stop(snd2);
    await sleep(100);

    const r = s.dj_sync_start(snd2, firstBeat, snd1, firstBeat, barDur, 1);
    await sleep(200);

    const p1 = s.dj_get_position(snd1);
    const p2 = s.dj_get_position(snd2);
    const diff = (p2 - p1) * 1000;
    const playing = s.dj_is_playing(snd2);
    console.log(`  cycle=${cycle} sync=${r} playing=${playing} t1=${p1.toFixed(4)} t2=${p2.toFixed(4)} diff=${diff.toFixed(1)}ms`);
  }

  s.dj_stop(snd1);
  s.dj_stop(snd2);
  await sleep(100);

  // ====== TEST 4: Seek track 2 to different position, then sync ======
  console.log("\n--- TEST 4: T2 seeked to 30s, sync to T1 ---");
  s.dj_play(snd1);
  await sleep(2000);

  // Seek track 2 to 30s, find nearest downbeat
  let targetBeat = firstBeat;
  for (let i = 0; i < beatCount; i += 4) {
    if (beatBuf[i]! >= 30) { targetBeat = beatBuf[i]!; break; }
  }
  console.log(`  Target downbeat near 30s: ${targetBeat.toFixed(3)}s`);

  const r4 = s.dj_sync_start(snd2, targetBeat, snd1, firstBeat, barDur, 0);
  console.log(`  sync_start result: ${r4}`);

  for (let i = 0; i < 10; i++) {
    await sleep(100);
    const p1 = s.dj_get_position(snd1);
    const p2 = s.dj_get_position(snd2);
    const absDiff = Math.abs(p2 - p1) * 1000;
    const phaseDiff = (((p2 - p1) % barDur) + barDur) % barDur * 1000;
    const phaseErr = Math.min(phaseDiff, barDur * 1000 - phaseDiff);
    console.log(`  t1=${p1.toFixed(4)} t2=${p2.toFixed(4)} absDiff=${absDiff.toFixed(0)}ms phaseErr=${phaseErr.toFixed(1)}ms`);
  }

  // ====== TEST 5: Stop/restart drift check (long measurement) ======
  console.log("\n--- TEST 5: T1 plays 5s, stop T2, sync T2, measure 5s ---");
  s.dj_play(snd1);
  await sleep(5000);

  // Stop and restart track 2
  s.dj_stop(snd2);
  await sleep(100);

  const r5 = s.dj_sync_start(snd2, firstBeat, snd1, firstBeat, barDur, 1);
  console.log(`sync_start result: ${r5}`);

  // Measure for 5 seconds at 200ms intervals
  const diffs: number[] = [];
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const p1 = s.dj_get_position(snd1);
    const p2 = s.dj_get_position(snd2);
    const diff = (p1 - p2) * 1000;
    let phase = ((p2 - p1) % barDur);
    if (phase > barDur / 2) phase -= barDur;
    if (phase < -barDur / 2) phase += barDur;
    const phaseErr = Math.abs(phase) * 1000;
    diffs.push(diff);
    console.log(`  t1=${p1.toFixed(4)} t2=${p2.toFixed(4)} diff=${diff.toFixed(1)}ms phaseErr=${phaseErr.toFixed(1)}ms`);
  }
  // Show drift: compare first vs last diff
  const drift = diffs[diffs.length - 1]! - diffs[0]!;
  console.log(`  DRIFT over 5s: ${drift.toFixed(1)}ms (${(drift / 5).toFixed(1)}ms/s)`);

  s.dj_stop(snd1);
  s.dj_stop(snd2);
  await sleep(100);

  // ====== TEST 6: Double stop/restart (two cycles) ======
  console.log("\n--- TEST 6: Two stop/restart cycles, measure after each ---");
  s.dj_play(snd1);
  await sleep(3000);

  for (let cycle = 0; cycle < 2; cycle++) {
    s.dj_stop(snd2);
    await sleep(100);
    s.dj_sync_start(snd2, firstBeat, snd1, firstBeat, barDur, 1);

    const cycleDiffs: number[] = [];
    for (let i = 0; i < 15; i++) {
      await sleep(200);
      const p1 = s.dj_get_position(snd1);
      const p2 = s.dj_get_position(snd2);
      const diff = (p1 - p2) * 1000;
      cycleDiffs.push(diff);
      let phase = ((p2 - p1) % barDur);
      if (phase > barDur / 2) phase -= barDur;
      if (phase < -barDur / 2) phase += barDur;
      console.log(`  cycle=${cycle} t1=${p1.toFixed(4)} t2=${p2.toFixed(4)} diff=${diff.toFixed(1)}ms phaseErr=${(Math.abs(phase)*1000).toFixed(1)}ms`);
    }
    const d = cycleDiffs[cycleDiffs.length - 1]! - cycleDiffs[0]!;
    console.log(`  cycle=${cycle} DRIFT over 3s: ${d.toFixed(1)}ms (${(d / 3).toFixed(1)}ms/s)`);
  }

  s.dj_stop(snd1);
  s.dj_stop(snd2);
  await sleep(100);

  // ====== TEST 7: Legacy pause/resume reproducer ======
  console.log("\n--- TEST 7: Legacy nearest-downbeat pause/resume reproducer ---");
  s.dj_play(snd1);
  await sleep(1500);
  s.dj_sync_start(snd2, firstBeat, snd1, firstBeat, barDur, 1);
  await sleep(500);

  for (let cycle = 0; cycle < 5; cycle++) {
    await sleep(900);
    const beforePause = s.dj_get_position(snd2);
    s.dj_pause(snd2);
    await sleep(100);
    const pausedPos = s.dj_get_position(snd2);
    const targetBeat = legacyNearestDownbeat(beatBuf, beatCount, pausedPos);
    const r = s.dj_sync_start(snd2, targetBeat, snd1, firstBeat, barDur, 0);
    await sleep(250);
    const p1 = s.dj_get_position(snd1);
    const p2 = s.dj_get_position(snd2);
    const playing = s.dj_is_playing(snd2);
    const diff = (p2 - p1) * 1000;
    console.log(
      `  cycle=${cycle} beforePause=${beforePause.toFixed(4)} paused=${pausedPos.toFixed(4)} ` +
      `targetBeat=${targetBeat.toFixed(4)} sync=${r} playing=${playing} diff=${diff.toFixed(1)}ms`
    );
  }

  // Cleanup
  s.dj_stop(snd1);
  s.dj_stop(snd2);
  s.dj_unload_sound(snd1);
  s.dj_unload_sound(snd2);
  s.dj_destroy_engine(engine);
  s.dj_shutdown();

  console.log("\n=== Tests complete ===");
}

runTest().catch(console.error);
