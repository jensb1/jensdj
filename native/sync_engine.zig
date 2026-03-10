// sync_engine.zig — Zig-based sync engine for JensDJ
//
// Moves sync orchestration into the native engine so positions are read
// atomically (zero RPC latency). The frontend becomes a thin visualization
// layer that just calls dj_sync_play(target, source).

const std = @import("std");

const c_alloc = std.heap.c_allocator;

// ---------------------------------------------------------------------------
// Extern C functions (defined in existing C modules, resolved at link time)
// ---------------------------------------------------------------------------

extern fn dj_get_position(sound: ?*anyopaque) f32;
extern fn dj_is_playing(sound: ?*anyopaque) c_int;
extern fn dj_set_tempo(sound: ?*anyopaque, ratio: f32) void;
extern fn dj_get_tempo(sound: ?*anyopaque) f32;
extern fn dj_get_original_bpm(sound: ?*anyopaque) f32;
extern fn dj_set_global_clock(bar_duration: f32) void;
extern fn dj_align_global_clock(sound: ?*anyopaque) void;
extern fn dj_sync_start(
    target: ?*anyopaque,
    target_beat: f32,
    source: ?*anyopaque,
    source_beat: f32,
    bar_duration: f32,
    preserve_transport: c_int,
) c_int;

// Beat grid accessors (added to playback.c)
extern fn dj_internal_set_beat_grid(sound: ?*anyopaque, grid: ?*anyopaque) void;
extern fn dj_internal_get_beat_grid(sound: ?*anyopaque) ?*anyopaque;

// ---------------------------------------------------------------------------
// BeatGrid — port of src/shared/syncPlan.ts
// ---------------------------------------------------------------------------

const BeatGrid = struct {
    beats: []f32,
    bar_duration: f32,

    fn init(beats_ptr: [*]const f32, count: u32) ?*BeatGrid {
        if (count < 5) return null;

        const grid = c_alloc.create(BeatGrid) catch return null;
        const beats_copy = c_alloc.alloc(f32, count) catch {
            c_alloc.destroy(grid);
            return null;
        };
        @memcpy(beats_copy, beats_ptr[0..count]);

        grid.* = .{
            .beats = beats_copy,
            .bar_duration = computeBarDuration(beats_copy),
        };
        return grid;
    }

    fn deinit(self: *BeatGrid) void {
        c_alloc.free(self.beats);
        c_alloc.destroy(self);
    }

    /// Find the downbeat (every 4th beat) nearest to `position`.
    fn nearestDownbeat(self: *const BeatGrid, position: f32) f32 {
        var best: f32 = self.beats[0];
        var min_dist: f32 = @abs(self.beats[0] - position);
        var i: usize = 4;
        while (i < self.beats.len) : (i += 4) {
            const dist = @abs(self.beats[i] - position);
            if (dist < min_dist) {
                min_dist = dist;
                best = self.beats[i];
            }
        }
        return best;
    }

    /// Find any beat nearest to `position`.
    fn nearestBeat(self: *const BeatGrid, position: f32) struct { beat: f32, index: u32 } {
        var best_beat: f32 = self.beats[0];
        var best_index: u32 = 0;
        var min_dist: f32 = @abs(self.beats[0] - position);
        for (self.beats[1..], 1..) |beat, i| {
            const dist = @abs(beat - position);
            if (dist < min_dist) {
                min_dist = dist;
                best_beat = beat;
                best_index = @intCast(i);
            }
        }
        return .{ .beat = best_beat, .index = best_index };
    }

    /// Find the downbeat whose `beat + source_phase` is nearest to `target_pos`.
    fn phaseAlignedDownbeat(self: *const BeatGrid, target_pos: f32, source_phase: f32) f32 {
        var best_beat: f32 = self.beats[0];
        var best_dist: f32 = @abs(self.beats[0] + source_phase - target_pos);
        var i: usize = 4;
        while (i < self.beats.len) : (i += 4) {
            const dist = @abs(self.beats[i] + source_phase - target_pos);
            if (dist < best_dist) {
                best_dist = dist;
                best_beat = self.beats[i];
            }
        }
        return best_beat;
    }

    /// Find nearest beat that has the same bar-phase index (0-3).
    fn nearestPhaseMatchedBeat(self: *const BeatGrid, position: f32, phase_index: u32) struct { beat: f32, index: u32 } {
        const start: usize = @min(phase_index, @as(u32, @intCast(self.beats.len - 1)));
        var best_beat: f32 = self.beats[start];
        var best_index: u32 = @intCast(start);
        var min_dist: f32 = @abs(self.beats[start] - position);
        var i: usize = start + 4;
        while (i < self.beats.len) : (i += 4) {
            const dist = @abs(self.beats[i] - position);
            if (dist < min_dist) {
                min_dist = dist;
                best_beat = self.beats[i];
                best_index = @intCast(i);
            }
        }
        return .{ .beat = best_beat, .index = best_index };
    }
};

/// Normalize an offset into [0, bar_duration).
fn normalizePhase(offset: f32, bar_duration: f32) f32 {
    if (bar_duration <= 0) return 0;
    var phase = @rem(offset, bar_duration);
    if (phase < 0) phase += bar_duration;
    return phase;
}

/// Compute bar duration as median of up to 8 four-beat intervals.
fn computeBarDuration(beats: []const f32) f32 {
    if (beats.len < 5) return 2.0;

    var intervals: [8]f32 = undefined;
    var count: usize = 0;
    var i: usize = 0;
    while (i + 4 < beats.len and count < 8) : (i += 4) {
        intervals[count] = beats[i + 4] - beats[i];
        count += 1;
    }
    if (count == 0) return 2.0;

    // Insertion sort (max 8 elements)
    {
        var si: usize = 1;
        while (si < count) : (si += 1) {
            var j = si;
            while (j > 0 and intervals[j - 1] > intervals[j]) {
                const tmp = intervals[j];
                intervals[j] = intervals[j - 1];
                intervals[j - 1] = tmp;
                j -= 1;
            }
        }
    }

    return intervals[count / 2];
}

// ---------------------------------------------------------------------------
// SyncState — global sync orchestration state
// ---------------------------------------------------------------------------

const MAX_TRACKS = 16;

const SyncState = struct {
    master_bpm: f32 = 0,
    tracks: [MAX_TRACKS]?*anyopaque = .{null} ** MAX_TRACKS,
    track_count: u32 = 0,
};

var sync_state = SyncState{};

// ---------------------------------------------------------------------------
// Helper: get BeatGrid from a sound pointer
// ---------------------------------------------------------------------------

fn getBeatGrid(sound: ?*anyopaque) ?*const BeatGrid {
    const ptr = dj_internal_get_beat_grid(sound) orelse return null;
    return @ptrCast(@alignCast(ptr));
}

// ---------------------------------------------------------------------------
// Exported C API
// ---------------------------------------------------------------------------

/// Version check — returns 1 to confirm Zig module is linked.
export fn dj_zig_version() callconv(.c) c_int {
    return 1;
}

/// Store a beat grid on a sound. Called once after beat detection.
/// The beat grid is heap-allocated and freed on unload or replacement.
export fn dj_set_beats(sound: ?*anyopaque, beats: [*]const f32, count: c_int) callconv(.c) void {
    if (sound == null or count < 5) return;

    // Free existing beat grid
    if (dj_internal_get_beat_grid(sound)) |existing| {
        const grid: *BeatGrid = @ptrCast(@alignCast(existing));
        grid.deinit();
        dj_internal_set_beat_grid(sound, null);
    }

    const grid = BeatGrid.init(beats, @intCast(@as(u32, @bitCast(count)))) orelse return;
    dj_internal_set_beat_grid(sound, @ptrCast(grid));
}

/// Atomic sync play — replaces the entire frontend syncPlay.ts orchestration.
///
/// 1. Reads source position atomically (zero latency)
/// 2. Looks up stored beat grids
/// 3. Computes phase-aligned target beat
/// 4. Delegates to dj_sync_start (tempo, clock, sync)
///
/// target_anchor_pos: if >= 0, use as the target position for downbeat search
///                    instead of the current target position.
/// Returns 0 on success, -1 on error.
export fn dj_sync_play(target: ?*anyopaque, source: ?*anyopaque, target_anchor_pos: f32) callconv(.c) c_int {
    if (target == null or source == null) return -1;

    // Get beat grids
    const src_grid = getBeatGrid(source) orelse return -1;
    const tgt_grid = getBeatGrid(target) orelse return -1;
    if (src_grid.beats.len < 5 or tgt_grid.beats.len < 5) return -1;

    // Read positions ATOMICALLY (same process, no RPC round-trip)
    const source_pos = dj_get_position(source);
    const target_pos = if (target_anchor_pos >= 0) target_anchor_pos else dj_get_position(target);

    // Compute source bar duration (file-time) and phase
    const bar_duration = src_grid.bar_duration;
    const source_phase = normalizePhase(source_pos - src_grid.beats[0], bar_duration);

    // Find phase-aligned target downbeat
    const target_beat = tgt_grid.phaseAlignedDownbeat(target_pos, source_phase);

    // Compute output bar duration (wall-clock time)
    // tempo = master_bpm / original_bpm, time_ratio = 1/tempo
    // output_bar = file_bar * time_ratio = file_bar / tempo
    const source_tempo = dj_get_tempo(source);
    const output_bar_duration = if (source_tempo > 0) bar_duration / source_tempo else bar_duration;

    std.debug.print(
        "[zig_sync_play] src_pos={d:.4} tgt_pos={d:.4} bar={d:.4} phase={d:.4} tgt_beat={d:.4} out_bar={d:.4} tempo={d:.4}\n",
        .{ source_pos, target_pos, bar_duration, source_phase, target_beat, output_bar_duration, source_tempo },
    );

    // dj_sync_start handles: stop target, match tempo, set beat_ref, setup
    // global clock, align clock to source, sync target to clock.
    return dj_sync_start(target, target_beat, source, src_grid.beats[0], output_bar_duration, 0);
}

/// Set master BPM — applies tempo to all registered tracks and sets global clock.
export fn dj_set_master_bpm(bpm: f32) callconv(.c) void {
    sync_state.master_bpm = bpm;

    // Apply tempo ratio to every registered track
    for (&sync_state.tracks) |maybe_track| {
        const track = maybe_track orelse continue;
        const original_bpm = dj_get_original_bpm(track);
        if (original_bpm > 0 and bpm > 0) {
            dj_set_tempo(track, bpm / original_bpm);
        } else if (bpm == 0) {
            dj_set_tempo(track, 1.0);
        }
    }

    // Set global beat clock
    if (bpm > 0) {
        dj_set_global_clock(4.0 * 60.0 / bpm);
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

/// Free the beat grid associated with a sound.
/// Called from C's dj_unload_sound before freeing the DJSound.
export fn dj_free_beat_grid(sound: ?*anyopaque) callconv(.c) void {
    if (sound == null) return;
    const grid_ptr = dj_internal_get_beat_grid(sound) orelse return;
    const grid: *BeatGrid = @ptrCast(@alignCast(grid_ptr));
    grid.deinit();
    dj_internal_set_beat_grid(sound, null);
}
