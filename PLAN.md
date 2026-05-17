# DJ Backend — Rust Implementation Plan

A full-feature DJ audio backend in Rust. **One-shot implementation**: the implementing AI must decide every remaining detail itself and ship a working backend without asking the user questions. Every choice that could have been a question has been pre-decided in this document. When you (the implementing AI) hit something genuinely undecidable, choose the simpler option and write a one-line note in `DECISIONS.md` rather than blocking.

The Zig implementation in `../jensdjold/` is a **feature reference only**. Its architecture is buggy and must not be copied. Read it to confirm "did the old version expose feature X?" — never to copy structure or algorithms.

---

## 1. Mission

Build `djengine`, a Rust workspace that provides:

- Multi-deck audio playback with pitch-preserving tempo change
- Sample-accurate beat sync across an arbitrary number of decks
- BPM and beat-grid extraction
- Waveform peak extraction
- Loop control (beat-aligned and raw in/out)
- Stdio JSON-RPC command interface
- Shared-memory ring for high-frequency playback telemetry

The backend is consumed by a separate frontend (out of scope). It runs as a subprocess.

---

## 2. Locked Tech Stack

| Concern | Choice | Notes |
|---|---|---|
| Audio I/O | `cpal` behind a `Backend` trait | trait lets `coreaudio-rs` slot in later for multi-output |
| Decoder | `symphonia` | mp3/flac/wav/ogg/aac/alac |
| Time-stretch | `signalsmith-stretch` Rust crate, behind a `Stretcher` trait | MIT, **deterministic block I/O is the reason for this choice** |
| BPM/beat detection | `aubio-rs` + custom onset/drift correction | offline only, never on audio thread |
| FFI | stdio JSON-RPC for commands; shared-memory SPSC ring for ticks | UI process is separate; crash isolation matters |
| Realtime IPC | `rtrb` (SPSC ring) for UI↔audio; `basedrop` for off-thread drops; `arc-swap` / atomics for scalar params | zero alloc / zero locks / zero logging inside the audio callback |
| Serialization | `serde` + `serde_json` for RPC; raw `repr(C)` structs for the tick ring | |
| Async runtime | none in audio path; `tokio` only in the RPC main loop | |
| Testing | `cargo test` + a dedicated `sync_drift` integration test as the gate | |
| MSRV | latest stable Rust at time of implementation | |
| Platforms | macOS, Linux, Windows | cpal covers all three |

Crate versions: use the latest stable release on crates.io as of build time. Pin in `Cargo.lock`.

---

## 3. Feature Scope

### In scope
- N decks (created/destroyed dynamically at runtime; no hard cap below 16)
- Load track from path → decode → store decoded PCM in memory
- Play, pause, stop, seek
- Set volume per deck
- Set tempo ratio per deck (1.0 = original, pitch preserved)
- Set original BPM per deck (used to derive ratio from master BPM)
- Designate any deck as master; master is switchable at runtime
- Sync engage on a deck: matches its tempo to master's effective BPM **and** sample-accurately aligns its next downbeat to the master's grid (zero-sample phase drift target)
- Sync disengage: deck continues playing at its current ratio, no phase tracking
- Master BPM control (manual override or follows master deck's effective BPM)
- BPM detection (offline, from file path)
- Beat grid extraction (offline; returns array of beat times in seconds)
- Waveform peaks (mono, configurable point count)
- Loop in/out (raw seconds)
- Loop beat-aligned helpers: 1/2, 1, 2, 4, 8, 16 beats, snapped to nearest beat from grid
- Loop active/inactive flag; clear loop
- Playback telemetry stream at ~60 Hz per active deck via the tick ring

### Out of scope (do NOT implement)
- EQ (any band count)
- DJ filter (single-knob LP/HP sweep)
- MIDI input or output
- Parameter automation / cue points / hot cues
- Track library, crates, SQLite, any persistence
- 3-band colored waveforms
- Effects (reverb, delay, etc.)
- Recording / streaming output
- GUI of any kind

If a feature is not in the "In scope" list, do not build it. Resist the urge to add "obvious" extras.

---

## 4. Critical Invariants

These must hold or sync is broken. Encode them as tests where possible.

1. **One global frame clock.** A single monotonic `u64` counter incremented by the cpal callback per frame consumed by the device. Every time-related decision in the engine is expressed in global frames. **Never use `Instant::now`, `SystemTime`, or wall-clock anywhere in the audio path.**

2. **Deterministic stretcher I/O.** The chosen `Stretcher` implementation must produce exactly `f(input_frames, ratio)` output frames for a given input count — no internal nondeterministic buffering that makes output position a non-pure function of input. Validate this in a unit test before building anything on top.

3. **All deck positions in global-frame space.** Each deck maintains `(global_frame_at_start, source_frame_at_start, sample_rate, current_ratio)` and an affine map from global frames → source frames. Reading "where is the deck right now" is `f(current_global_frame)`, not a polled position from the stretcher.

4. **Sync engagement is a seek.** When sync engages, compute the source-frame position the follower needs at the next master-downbeat global frame, then seek the follower's source there and reset the stretcher. **Do not** drift-correct by nudging rate over time — that's a different feature (not in scope).

5. **No allocation in the audio callback.** Pre-allocate every buffer at deck creation. The callback may only: read from ringbuf, do FP math, write to output buffer, update atomics, push to telemetry ring. No `Vec::push`, no `String`, no `println!`, no `log::*`, no `Mutex`, no `Box::new`.

6. **Master switching is atomic.** Changing which deck is master must not glitch audio or cause any synced follower to lose phase by more than one block.

7. **A failing drift test fails the build.** See §9.

---

## 5. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  djengine process                                                │
│                                                                  │
│  ┌────────────────┐    JSON cmd    ┌─────────────────────────┐   │
│  │  RPC main      │ ─────────────▶ │  Command ring (rtrb)    │   │
│  │  (tokio,       │                └────────────┬────────────┘   │
│  │   stdio)       │                             │                │
│  │                │ ◀─── ack ──────             ▼                │
│  └────────────────┘                  ┌─────────────────────┐     │
│         ▲                            │  Audio callback     │     │
│         │                            │  (cpal, RT thread)  │     │
│         │  telemetry ring            │   - global clock    │     │
│         │  (shared mem,              │   - per-deck mix    │     │
│         │   ~60 Hz)                  │   - sync math       │     │
│         └─────────────── tick ─────▶ │   - stretcher.pull  │     │
│                                      └─────────────────────┘     │
│                                                                  │
│  ┌────────────────────────┐                                      │
│  │  Analysis worker pool  │   (rayon / std threads; offline)     │
│  │   - BPM, beats, peaks  │   results returned via RPC response  │
│  └────────────────────────┘                                      │
└──────────────────────────────────────────────────────────────────┘
```

Three thread classes:
- **RPC thread** (tokio): parses stdio JSON, validates, pushes commands to the audio ring; reads responses, writes to stdout.
- **Audio thread** (cpal callback): owns deck state, advances global clock, mixes output. **Hard realtime constraints.**
- **Analysis workers** (rayon): decode + analyze a file, return result via RPC. Never touches deck state directly.

Cross-thread state:
- UI → Audio: SPSC ringbuf of `Command` enums
- Audio → UI: SPSC ringbuf of `Tick` structs (lossy is OK — overwrite oldest on overflow)
- Shared params (volume, tempo ratio, etc.): `arc_swap::ArcSwap<DeckParams>` per deck, OR individual atomics. Pick atomics for scalars, ArcSwap for compound updates.

---

## 6. Module Layout

```
djengine/
├── Cargo.toml                  workspace manifest
├── PLAN.md                     this file
├── DECISIONS.md                created by implementer; one line per ambiguity resolved
├── crates/
│   ├── djengine-core/          pure library, no I/O
│   │   ├── beat_grid.rs        beat array + bar duration; phase math
│   │   ├── sync.rs             master-sync engagement algorithm; pure functions
│   │   ├── clock.rs            global frame clock type
│   │   ├── deck_state.rs       affine source↔global map; tempo math
│   │   └── lib.rs
│   ├── djengine-analysis/      offline analysis (no realtime constraints)
│   │   ├── decode.rs           symphonia wrapper → Vec<f32> PCM
│   │   ├── peaks.rs            mono waveform peak extraction
│   │   ├── bpm.rs              aubio-rs wrapper
│   │   ├── beats.rs            onset detection + drift correction
│   │   └── lib.rs
│   ├── djengine-audio/         realtime audio engine
│   │   ├── backend/
│   │   │   ├── mod.rs          Backend trait
│   │   │   └── cpal.rs         cpal impl
│   │   ├── stretch/
│   │   │   ├── mod.rs          Stretcher trait
│   │   │   └── signalsmith.rs  signalsmith-stretch impl
│   │   ├── deck.rs             realtime deck (PCM + stretcher + state)
│   │   ├── engine.rs           N decks + global clock + sync controller
│   │   ├── commands.rs         Command enum + processor
│   │   ├── telemetry.rs        Tick struct + ring writer
│   │   └── lib.rs
│   └── djengine-rpc/           stdio JSON-RPC + tick ring exposure
│       ├── protocol.rs         JSON schema (request/response/notification)
│       ├── server.rs           tokio stdio loop
│       ├── tick_ring.rs        shared-memory SPSC ring (memmap-based)
│       └── main.rs             binary entry point
└── tests/
    ├── sync_drift.rs           THE gate test; see §9
    ├── analysis_basics.rs
    ├── stretcher_determinism.rs
    └── deck_basics.rs
```

A workspace (not single crate) makes the realtime/non-realtime split visible at the dependency level: `djengine-audio` must not depend on `djengine-analysis`.

---

## 7. Sub-Agent Strategy

You (the implementing AI orchestrator) have access to sub-agents. Use them deliberately, not reflexively.

### When to spawn agents

**Always parallelize these independent batches:**

- During the **scaffolding phase**: spawn three `general-purpose` agents in parallel to set up:
  1. `djengine-core` (pure math, no deps beyond `serde`)
  2. `djengine-analysis` (symphonia + aubio-rs)
  3. `djengine-rpc` protocol types (just `serde` structs + JSON schema)

  These have zero overlap; doing them sequentially wastes wall-clock time.

- During **analysis implementation**: spawn parallel agents for peaks, BPM, beats. Independent files, no shared state, easy to verify in isolation.

- During **test writing**: once a module is built, spawn one agent per test file in `tests/`. They only need the public API.

**Use the `Explore` agent (read-only, fast) for:**

- Confirming which features the Zig reference exposes. Example query: "What functions in `../jensdjold/native/src/` deal with loops? List the function names and one-line summaries." Do not let it read whole files into your context.
- Checking crate API surface from `Cargo.toml` + `lib.rs` in `~/.cargo/registry/` after `cargo fetch` if you need to confirm a signature without leaving the loop.

**Use the `Plan` agent for exactly one task:** designing the sync engagement algorithm before you write `djengine-core/sync.rs`. The math must be right the first time. Give it: the invariants in §4, the global clock model in §5, the Mixxx reference link in §10, and ask for the engagement algorithm as pure pseudocode.

### When NOT to spawn agents

- **Never parallelize** `djengine-audio/deck.rs`, `djengine-audio/engine.rs`, and `djengine-core/sync.rs`. These three files form one tightly coupled subsystem and must be designed together. Write them yourself, in sequence, with the sync drift test running.

- **Never spawn an agent to "implement the sync system"** as a single task. Sync is the project's hardest correctness problem; it's where a one-shot AI most often produces something that sounds right and drifts silently. You must hold this code in your own working memory.

- Don't spawn agents for files under ~80 lines or for trivial wrappers. The orchestration overhead exceeds the savings.

### Sub-agent prompt template for this project

When delegating a module, the prompt MUST include:

1. The exact file path(s) to create
2. The public function signatures expected
3. A pointer to which invariants from §4 apply (e.g., "this runs on the audio thread — invariant 5 applies, no allocation")
4. The crate name and version to use
5. A verification command the agent can run before reporting done (`cargo build -p <crate>` minimum; `cargo test -p <crate>` if tests exist)

Always end agent prompts with: "Report what you built and what you verified, under 150 words. Do not summarize this prompt back."

### Worktree isolation

For any agent spawned during the **scaffolding** or **analysis** phases, use `isolation: "worktree"` so parallel agents don't trample each other's `Cargo.toml`. Merge sequentially. Do **not** worktree-isolate agents touching `djengine-audio/` — that subsystem is single-threaded by design.

---

## 8. Implementation Phases

Execute in order. Each phase has a **done criterion**: a command that must succeed before moving on. Do not advance past a failed gate.

### Phase 0 — Scaffolding (parallelize: 3 agents)

- Create workspace `Cargo.toml`, the four crate directories, empty `lib.rs` files.
- Spawn three parallel worktree agents to populate the empty crates' `Cargo.toml` and minimal `lib.rs` stubs with the dependencies from §2. (One per crate; `djengine-rpc` last since it depends on the others.)
- Merge worktrees sequentially.

**Done:** `cargo build --workspace` succeeds with empty crates.

### Phase 1 — Stretcher determinism test (do this BEFORE anything else)

Before building any engine code, write `tests/stretcher_determinism.rs`:

- Feed `signalsmith-stretch` a known PCM buffer (e.g., 10 seconds of a 1 kHz sine at 48 kHz, stereo) at ratios 1.0, 0.5, 2.0, 1.234.
- Assert: for the same input + ratio, output frame count is deterministic across runs.
- Assert: output frame count is within ±2 frames of `ceil(input_frames * ratio)` at steady state (accounting for start-pad).
- Assert: total energy preserved within a tolerance.

**Done:** test passes. If it fails, the rest of the plan is invalid — stop and reassess the stretcher choice in `DECISIONS.md`.

### Phase 2 — `djengine-core` (do yourself, no agents)

Implement:
- `clock.rs`: `GlobalClock` wrapping `AtomicU64` (frames consumed). Single producer (audio callback), many readers.
- `beat_grid.rs`: `BeatGrid { beats: Vec<f32>, bar_duration: f32 }` + median-bar-duration computation + nearest-beat / nearest-downbeat / phase-aligned-downbeat methods. Port the math from `../jensdjold/native/src/beat_grid.zig` but **rewrite, do not copy**.
- `deck_state.rs`: `DeckPosition` type holding the affine map from global frames to source frames given a ratio and an anchor. Provide `global_to_source(global_frame) -> source_frame` and `source_to_global(source_frame) -> global_frame` as pure functions.
- `sync.rs`: pure function `compute_sync_seek(follower_grid, master_grid, master_pos_in_master_grid, current_global_frame, master_bar_duration) -> SyncSeek { follower_source_frame, follower_ratio }`. **Spawn the `Plan` agent here first** to lock the algorithm before writing it.

Unit tests for each: beat grid edge cases (empty, single beat, sparse), sync math at multiple offsets, affine map round-trips.

**Done:** `cargo test -p djengine-core` passes.

### Phase 3 — `djengine-analysis` (parallelize: 3 agents)

Three parallel worktree agents:
1. `decode.rs` + `peaks.rs` — Symphonia decode → `Vec<f32>` mono PCM → mono peak extraction.
2. `bpm.rs` — aubio-rs tempo extraction from a file path.
3. `beats.rs` — onset detection + drift correction. The implementer should look at `../jensdjold/native/src/analysis.zig` only to copy the **algorithm idea** (rough BPM from transients → onset strength → BPM + phase scan → drift correction via linear regression). Rewrite cleanly in idiomatic Rust.

Each agent must include unit tests on small synthetic audio (a few generated sine + click patterns).

**Done:** `cargo test -p djengine-analysis` passes on synthetic inputs. Also run a manual smoke test on one real audio file (place a `test-assets/sample.flac` if needed) and verify BPM is within ±0.5 of the truth value.

### Phase 4 — `djengine-audio` skeleton (do yourself)

Implement, in this order:
1. `Backend` trait + cpal impl. Backend exposes `start(callback: impl FnMut(&mut [f32], FrameInfo))` where `FrameInfo` includes the global frame at start of the buffer.
2. `Stretcher` trait + signalsmith impl. Trait exposes `feed(input: &[f32])`, `pull(output: &mut [f32]) -> usize`, `set_ratio(f64)`, `reset()`. Block-deterministic.
3. `Deck`: owns decoded PCM (Arc'd from analysis), stretcher, `DeckPosition`, loop state, volume atomic, ratio atomic. **Pre-allocates everything.** No `Vec::push` after construction.
4. `Engine`: holds `Vec<Option<Deck>>` (slot-based for stable IDs), global clock, master deck ID, command ring receiver. Audio callback walks active decks, pulls frames, mixes to output, advances clock, pushes telemetry ticks.
5. `Command` enum: `Load`, `Unload`, `Play`, `Pause`, `Seek`, `SetVolume`, `SetTempo`, `SetOriginalBpm`, `SetMaster`, `EngageSync`, `DisengageSync`, `SetLoop`, `SetLoopBeats`, `ClearLoop`, `SetMasterBpm`.

**Done:** `cargo build -p djengine-audio` succeeds; deck can play a file end-to-end through cpal default device.

### Phase 5 — Sync (do yourself; this is the hard part)

Wire `djengine-core::sync::compute_sync_seek` into `Engine::engage_sync`:
1. Compute the target seek using the pure function.
2. Apply: call `Deck::seek(source_frame)` and `Stretcher::reset()` then `Stretcher::set_ratio(new_ratio)` on the follower.
3. Mark follower as "synced to master".
4. Master-switching: clear all "synced to master" flags, set new master, re-engage sync on each former follower.

Telemetry must include per-deck phase difference vs master in samples for diagnostic visibility.

**Done:** the drift test in Phase 6 passes.

### Phase 6 — The sync drift test (NON-NEGOTIABLE GATE)

Implement `tests/sync_drift.rs`:

- Pull frames offline (do NOT require an audio device — `Engine` must support `process_offline(num_frames, &mut [f32])` for testing).
- Create two decks loaded with the same generated PCM (e.g., a 120 BPM click track, 10 minutes long).
- Set BPMs (e.g., master at 120, follower's "original BPM" at 100 so ratio is 1.2).
- Engage sync on follower.
- Process 10 minutes of output frames.
- Assert: the follower's beat positions, mapped back to global frame space, are within **1 sample** of the master's corresponding beats over the entire run.
- Additional test: switch master to the follower mid-run; assert phase preserved.
- Additional test: stop and restart playback; assert phase preserved.

If this test does not pass, **the project is not done**. Do not declare completion.

### Phase 7 — `djengine-rpc` (parallelize: protocol types + server)

1. `protocol.rs`: JSON request/response/notification types as `serde` structs. One enum per RPC method. Mirror the `Command` enum closely; add `LoadTrackAnalyze` and `GetAnalysis` for offline analysis calls.
2. `tick_ring.rs`: a fixed-size memory-mapped SPSC ring for `Tick` structs. Frontend mmaps the same file. Use `memmap2`.
3. `server.rs`: tokio stdio loop. One JSON object per line on stdin → parse → push command to audio ring (for realtime commands) or spawn rayon task (for analysis commands) → emit response on stdout.
4. `main.rs`: starts everything, handles shutdown on stdin close.

**Done:** running `cargo run -p djengine-rpc` and piping a `{"method":"load","params":{...}}` JSON line returns a response, and a deck can be played + monitored via the tick ring from a small standalone test harness.

### Phase 8 — Cross-platform validation

- `cargo build --workspace` on macOS, Linux, Windows.
- Drift test must pass on all three.
- Document any platform quirks in `DECISIONS.md`.

### Phase 9 — Final pass

Read the entire codebase once. Check:
- No `unwrap()` on user input paths
- No allocation inside the cpal callback (search for `Vec::`, `Box::`, `String::`, `format!`, `to_owned`)
- No `Instant::now()` outside test code
- No `Mutex` reachable from the audio callback
- `cargo clippy --workspace -- -D warnings` clean
- `cargo fmt --check` clean

Write a one-page `README.md` describing the JSON-RPC method surface. No other docs.

---

## 9. Testing & Verification

| Test | Layer | Gates |
|---|---|---|
| `stretcher_determinism.rs` | unit | Phase 1 |
| `djengine-core` unit tests | unit | Phase 2 |
| `djengine-analysis` unit + smoke | unit + small fixture | Phase 3 |
| `sync_drift.rs` | integration, offline | Phase 6 — **build-failing** |
| `deck_basics.rs` | integration, offline | Phase 4 |
| `analysis_basics.rs` | integration | Phase 7 |

The **`sync_drift.rs` test is the project's central correctness gate.** If you find yourself tempted to relax its tolerance to make it pass, stop and fix the engine instead. A 5-sample drift is not "close enough" — it compounds, and DJs will hear it within a few minutes.

Manual verification (do once, near the end):
- Play a real track, change tempo while playing, confirm no audible click.
- Load two real tracks of different BPMs, engage sync, listen on headphones for phase lock.
- Engage and disengage sync ten times in a row; no glitches.

---

## 10. Reference Materials

External references for the implementing AI:

- **Mixxx Master Sync wiki**: <https://github.com/mixxxdj/mixxx/wiki/Master-Sync> — the cleanest plain-English explanation of master-sync's beat-distance phase model.
- **Mixxx engine source**: <https://github.com/mixxxdj/mixxx/tree/main/src/engine/sync> — GPL, read-only reference for the algorithm. Do **not** copy code.
- **Ableton Link**: <https://github.com/Ableton/link> — for clean tempo/phase math write-up; overkill as a dep but its math is right.
- **signalsmith-stretch**: <https://signalsmith-audio.co.uk/code/stretch/> — upstream docs for the time-stretcher.
- **cpal**: <https://github.com/RustAudio/cpal>
- **Symphonia**: <https://github.com/pdeljanov/Symphonia>
- **aubio-rs**: <https://github.com/katyo/aubio-rs>
- **rtrb**: <https://github.com/mgeier/rtrb>
- **basedrop**: <https://github.com/glowcoil/basedrop>

Internal reference (feature surface only — never architecture):
- `../jensdjold/native/djengine.h` — list of features the old version exposed.
- `../jensdjold/native/src/analysis.zig` — algorithm sketch for beats/BPM (the algorithm is reasonable; the code is buggy).
- `../jensdjold/src/shared/types.ts` — shape of the data the frontend expects (use as a starting hint for RPC types, but the new types are yours to design).

---

## 11. The biggest risk (read this before starting)

**Sample-accurate sync drifts silently.** A one-shot AI will wire up cpal + signalsmith + a master deck and the output will *sound* synced — but every tempo change quietly skews phase by a few samples per block because the stretcher's internal buffering wasn't modeled, or because the position math conflated source frames with output frames, or because the callback re-pulls under xrun. Twenty minutes later the decks are noticeably out and nobody knows why.

The defense is in the plan:
- **Phase 1** validates the stretcher's determinism before any engine code is written.
- **Phase 2** keeps the sync math in pure functions you can unit-test.
- **Invariant 1** forbids wall-clock; every position is expressed in global device frames.
- **Phase 6** asserts ≤1-sample drift over 10 minutes — and is a non-negotiable gate.

If you skip any of those, you have not built a DJ backend. You have built something that sounds like one for the first minute.

---

## 12. Definition of Done

The project is done when **all** of the following are true:

- [ ] `cargo build --workspace` succeeds on macOS, Linux, Windows.
- [ ] `cargo test --workspace` passes — including `sync_drift.rs` with ≤1-sample tolerance over 10 minutes.
- [ ] `cargo clippy --workspace -- -D warnings` is clean.
- [ ] The RPC binary accepts JSON commands on stdin, returns responses on stdout, and produces audio through the default output device.
- [ ] Two decks can be played simultaneously, synced, with audible phase lock.
- [ ] Manual checks in §9 pass.
- [ ] `DECISIONS.md` exists and lists every undocumented choice made.
- [ ] `README.md` documents the JSON-RPC method surface in one page.

Nothing else needs to be built. Nothing else needs to be documented.
