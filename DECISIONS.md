# Decisions

- The legacy Zig reference directory `../jensdjold` is absent in this workspace, so behavior is implemented from `PLAN.md` and public reference concepts only.
- `aubio-rs` is built with `bindgen` + bundled aubio because the crate has no prebuilt bindings for this host/toolchain.
- Realtime deck tempo ratios are clamped to `0.25..=4.0` to keep preallocated stretcher buffers bounded.
- Sync uses an internal global master BPM/phase clock; `set_master` only copies a deck's current phase into that clock and does not make the deck authoritative.
- Public RPC seek and loop commands are beat-grid based; source-second controls are retained only as `raw_*` escape hatches.
- Tick ring format version 2 uses a 32-byte header and 128-byte records so frontend renderers can read beat-aware telemetry without JSON polling.
