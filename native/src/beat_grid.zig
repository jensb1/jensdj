// beat_grid.zig — BeatGrid struct + sync plan math (port of syncPlan.ts)

const std = @import("std");

const c_alloc = std.heap.c_allocator;

pub const BeatGrid = struct {
    beats: []f32,
    bar_duration: f32,

    pub fn init(beats_ptr: [*]const f32, count: u32) ?*BeatGrid {
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

    pub fn deinit(self: *BeatGrid) void {
        c_alloc.free(self.beats);
        c_alloc.destroy(self);
    }

    /// Find the downbeat (every 4th beat) nearest to `position`.
    pub fn nearestDownbeat(self: *const BeatGrid, position: f32) f32 {
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
    pub fn nearestBeat(self: *const BeatGrid, position: f32) struct { beat: f32, index: u32 } {
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
    pub fn phaseAlignedDownbeat(self: *const BeatGrid, target_pos: f32, source_phase: f32) f32 {
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
    pub fn nearestPhaseMatchedBeat(self: *const BeatGrid, position: f32, phase_index: u32) struct { beat: f32, index: u32 } {
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
pub fn normalizePhase(offset: f32, bar_duration: f32) f32 {
    if (bar_duration <= 0) return 0;
    var phase = @rem(offset, bar_duration);
    if (phase < 0) phase += bar_duration;
    return phase;
}

/// Compute bar duration as median of up to 8 four-beat intervals.
pub fn computeBarDuration(beats: []const f32) f32 {
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
