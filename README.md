# djengine

Rust DJ audio backend with multi-deck playback, offline analysis, sample-clock sync, line-delimited JSON-RPC over stdio, and optional memory-mapped telemetry ticks.

## Running

```sh
cargo run -p djengine-rpc
```

Set `DJENGINE_TICK_RING_PATH=/path/to/ticks.bin` to publish fixed-size telemetry records to a shared memory-mapped file. The 32-byte header is `version: u64`, `capacity: u64`, `record_bytes: u64`, `write_index: u64`; version 2 records are 128 bytes and include deck/global beat positions for frontend waveform rendering.

## JSON-RPC

Send one JSON object per stdin line. Responses are one JSON object per stdout line:

```json
{"id":1,"method":"ping","params":{}}
{"id":2,"method":"load","params":{"deck_id":0,"path":"/music/track.flac","analyze":true}}
{"id":3,"method":"set_global_master_bpm","params":{"bpm":120}}
{"id":4,"method":"engage_sync","params":{"deck_id":0}}
{"id":5,"method":"play","params":{"deck_id":0}}
```

Every response contains the original `id` when provided and either `result` or `error`.

## Methods

- `ping {}` returns `{"pong":true}`.
- `load {"deck_id"?:number,"path":string,"analyze"?:bool}` decodes a file, optionally extracts BPM/beats, and loads the deck. Returns deck id, sample rate, channels, frame count, BPM, and beats.
- `load_track_analyze {"path":string,"peak_points"?:number,"waveform_levels"?:number[]}` analyzes without loading. Returns BPM, beats, duration, default peaks, and multi-resolution `waveform_levels` for frontend waveform rendering. Alias: `get_analysis`, `get_waveform`, `analyze`.
- `unload|play|pause|stop {"deck_id":number}` control deck lifecycle and transport.
- `seek {"deck_id":number,"beat":number}` seeks to a beat-grid position. Alias: `seek_beat`.
- `jump_beats {"deck_id":number,"beats":number}` jumps relative to the current deck beat. Synced decks only accept whole-beat jumps so phase cannot be broken.
- `set_volume {"deck_id":number,"volume":number}` sets linear deck gain.
- `set_tempo {"deck_id":number,"ratio":number}` sets pitch-preserving tempo ratio.
- `set_original_bpm {"deck_id":number,"bpm":number}` updates deck BPM for sync math.
- `set_master {"deck_id":number}` copies that deck's current BPM and beat phase into the global master clock; the deck is not followed after that.
- `engage_sync {"deck_id":number}` aligns the deck to the next global-master downbeat and matches global BPM.
- `disengage_sync {"deck_id":number}` leaves the deck at its current tempo without phase tracking.
- `set_master_bpm {"bpm":number|null}` sets the global master BPM while preserving current global beat phase; `null` resets it to 120 BPM. Alias: `set_global_master_bpm`.
- `set_loop_beats {"deck_id":number,"start_beat"?:number,"length_beats":number}` creates a beat-grid loop. Alias: `set_loop`, `set_loop_current`.
- `clear_loop {"deck_id":number}` disables and clears the loop.
- `raw_seek_seconds {"deck_id":number,"seconds":number}` debug/raw escape hatch for source-second seeking.
- `raw_set_loop_seconds {"deck_id":number,"start_seconds":number,"end_seconds":number,"active"?:bool}` debug/raw escape hatch for source-second loop points.

## Frontend Waveforms

Waveform rendering is split into an offline shape and a realtime cursor:

1. Call `get_waveform`/`load_track_analyze` with `waveform_levels`, for example `{"path":"/music/track.mp3","waveform_levels":[1024,4096,16384]}`. The response returns `duration_seconds`, `beats`, a default `peaks` array, and sorted/deduplicated `waveform_levels`. Each peak entry is a mono min/max/RMS window that the frontend can cache per track.
2. Start the backend with `DJENGINE_TICK_RING_PATH` and memory-map that file from the frontend. Poll `write_index` and read the newest tick per deck. Render the playhead, beat grid, loop region, and sync error from tick beats rather than by polling JSON.

Tick ring v2 values are little-endian:

| Offset | Type | Field |
|---:|---|---|
| 0 | `u32` | `deck_id` |
| 8 | `u64` | `global_frame` |
| 16 | `f64` | `source_frame` |
| 24 | `f64` | `position_seconds` |
| 32 | `f64` | `deck_beat` |
| 40 | `f64` | `deck_bar` |
| 48 | `f64` | `global_master_beat` |
| 56 | `f64` | `global_master_bar` |
| 64 | `f64` | `global_master_bpm` |
| 72 | `f64` | `loop_start_beat` |
| 80 | `f64` | `loop_length_beats` |
| 88 | `f32` | `volume` |
| 96 | `f64` | `ratio` |
| 104 | `f64` | `effective_bpm` |
| 112 | `u8` | `playing` |
| 113 | `u8` | `synced` |
| 114 | `u8` | `loop_active` |
| 120 | `i64` | `phase_diff_samples` |

The frontend should draw the waveform in beat space when `beats` are available. `position_seconds` and `source_frame` are provided for raw inspection and non-gridded files, but synced deck UI should use `deck_beat` against the cached beat grid so loop and playhead rendering stays phase-locked.
