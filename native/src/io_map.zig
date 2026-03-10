// io_map.zig — IO mapping ring buffer for output↔input frame correspondence

const types = @import("types.zig");

/// Clear mapping history
pub fn ioMapReset(src: *types.DJStretchedSource) void {
    src.io_map_count = 0;
    src.io_map_write = 0;
}

/// Record current input↔output frame pair
pub fn ioMapRecord(src: *types.DJStretchedSource) void {
    const idx: usize = @intCast(src.io_map_write);
    src.io_map[idx] = .{
        .output_frame = src.output_frame_count,
        .input_frame = src.read_cursor,
    };
    src.io_map_write = @intCast((@as(usize, @intCast(src.io_map_write)) + 1) % types.IO_MAP_SIZE);
    if (src.io_map_count < types.IO_MAP_SIZE)
        src.io_map_count += 1;
}

/// Convert output frame position to estimated input frame position
pub fn ioMapOutputToInput(src: *types.DJStretchedSource, output_pos: u64) u64 {
    if (src.io_map_count == 0) {
        return @intFromFloat(@as(f64, @floatFromInt(output_pos)) / src.time_ratio);
    }

    const count: usize = @intCast(src.io_map_count);
    const oldest: usize = if (count < types.IO_MAP_SIZE) 0 else @intCast(src.io_map_write);

    var prev: ?*const types.IOMapEntry = null;
    var next: ?*const types.IOMapEntry = null;

    for (0..count) |i| {
        const idx = (oldest + i) % types.IO_MAP_SIZE;
        const e = &src.io_map[idx];
        if (e.output_frame <= output_pos) {
            prev = e;
        } else {
            next = e;
            break;
        }
    }

    if (prev) |p| {
        if (next) |n| {
            if (n.output_frame > p.output_frame) {
                const t = @as(f64, @floatFromInt(output_pos - p.output_frame)) /
                    @as(f64, @floatFromInt(n.output_frame - p.output_frame));
                return p.input_frame + @as(u64, @intFromFloat(t * @as(f64, @floatFromInt(n.input_frame - p.input_frame))));
            }
        }
        const extra: f64 = @floatFromInt(output_pos - p.output_frame);
        return p.input_frame + @as(u64, @intFromFloat(extra / src.time_ratio));
    }

    return @intFromFloat(@as(f64, @floatFromInt(output_pos)) / src.time_ratio);
}
