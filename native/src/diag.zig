// diag.zig — Diagnostic accessors

const c = @import("c.zig");
const types = @import("types.zig");

export fn dj_get_output_frame_count(sound: ?*anyopaque) callconv(.c) u64 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    const src = snd.source orelse return 0;
    return src.output_frame_count;
}

export fn dj_get_read_cursor(sound: ?*anyopaque) callconv(.c) u64 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    const src = snd.source orelse return 0;
    return src.read_cursor;
}

export fn dj_get_rb_latency(sound: ?*anyopaque) callconv(.c) c_int {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    const src = snd.source orelse return 0;
    if (src.rb == null) return 0;
    return @intCast(c.rubberband_get_latency(src.rb));
}

export fn dj_get_rb_available(sound: ?*anyopaque) callconv(.c) c_int {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    const src = snd.source orelse return 0;
    if (src.rb == null) return 0;
    return c.rubberband_available(src.rb);
}
