// sync_engine.zig — Central sync authority: master BPM, track registration,
// beat grid management, auto-aligned sync play.

const std = @import("std");
const types = @import("types.zig");
const c = @import("c.zig");
const beat_grid = @import("beat_grid.zig");
const sync = @import("sync.zig");
const playback = @import("playback.zig");
const tempo = @import("tempo.zig");

const c_alloc = std.heap.c_allocator;
const BeatGrid = beat_grid.BeatGrid;

const MAX_TRACKS = 16;

const SyncState = struct {
    master_bpm: f32 = 0,
    tracks: [MAX_TRACKS]?*anyopaque = .{null} ** MAX_TRACKS,
    track_count: u32 = 0,
};

var sync_state = SyncState{};

fn getBeatGrid(snd: *types.DJSound) ?*const BeatGrid {
    const ptr = snd.beat_grid orelse return null;
    return @ptrCast(@alignCast(ptr));
}

/// Free the beat grid associated with a sound.
pub fn freeBeatGrid(snd: *types.DJSound) void {
    const grid_ptr = snd.beat_grid orelse return;
    const grid: *BeatGrid = @ptrCast(@alignCast(grid_ptr));
    grid.deinit();
    snd.beat_grid = null;
}

/// Store a beat grid on a sound. Called once after beat detection.
export fn dj_set_beats(sound: ?*anyopaque, beats: [*]const f32, count: c_int) callconv(.c) void {
    if (count < 5) return;
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));

    // Free existing beat grid
    freeBeatGrid(snd);

    const grid = BeatGrid.init(beats, @intCast(@as(u32, @bitCast(count)))) orelse return;
    snd.beat_grid = @ptrCast(grid);
}

/// Atomic sync play — replaces the entire frontend syncPlay.ts orchestration.
export fn dj_sync_play(target: ?*anyopaque, source: ?*anyopaque, target_anchor_pos: f32) callconv(.c) c_int {
    const tgt_snd: *types.DJSound = @ptrCast(@alignCast(target orelse return -1));
    const src_snd: *types.DJSound = @ptrCast(@alignCast(source orelse return -1));

    const src_grid = getBeatGrid(src_snd) orelse return -1;
    const tgt_grid = getBeatGrid(tgt_snd) orelse return -1;
    if (src_grid.beats.len < 5 or tgt_grid.beats.len < 5) return -1;

    const source_pos = playback.dj_get_position(source);
    const target_pos = if (target_anchor_pos >= 0) target_anchor_pos else playback.dj_get_position(target);

    const bar_duration = src_grid.bar_duration;
    const source_phase = beat_grid.normalizePhase(source_pos - src_grid.beats[0], bar_duration);
    const target_beat = tgt_grid.phaseAlignedDownbeat(target_pos, source_phase);

    const source_tempo = tempo.dj_get_tempo(source);
    const output_bar_duration = if (source_tempo > 0) bar_duration / source_tempo else bar_duration;

    return sync.dj_sync_start(target, target_beat, source, src_grid.beats[0], output_bar_duration, 0);
}

/// Set master BPM — applies tempo to all registered tracks and sets global clock.
export fn dj_set_master_bpm(bpm: f32) callconv(.c) void {
    sync_state.master_bpm = bpm;

    for (&sync_state.tracks) |maybe_track| {
        const track = maybe_track orelse continue;
        const original_bpm = tempo.dj_get_original_bpm(track);
        if (original_bpm > 0 and bpm > 0) {
            tempo.dj_set_tempo(track, bpm / original_bpm);
        } else if (bpm == 0) {
            tempo.dj_set_tempo(track, 1.0);
        }
    }

    if (bpm > 0) {
        sync.dj_set_global_clock(4.0 * 60.0 / bpm);
    }
}

/// Get current master BPM.
export fn dj_get_master_bpm() callconv(.c) f32 {
    return sync_state.master_bpm;
}

/// Register a sound for master-tempo tracking.
export fn dj_register_track(sound: ?*anyopaque) callconv(.c) void {
    if (sound == null) return;
    for (&sync_state.tracks) |*slot| {
        if (slot.* == null) {
            slot.* = sound;
            sync_state.track_count += 1;
            return;
        }
    }
}

/// Unregister a sound from master-tempo tracking.
export fn dj_unregister_track(sound: ?*anyopaque) callconv(.c) void {
    if (sound == null) return;
    for (&sync_state.tracks) |*slot| {
        if (slot.* == sound) {
            slot.* = null;
            if (sync_state.track_count > 0) sync_state.track_count -= 1;
            return;
        }
    }
}

/// Free beat grid (called from dj_unload_sound).
export fn dj_free_beat_grid(sound: ?*anyopaque) callconv(.c) void {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    freeBeatGrid(snd);
}
