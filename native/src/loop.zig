// loop.zig — Loop control

const types = @import("types.zig");

export fn dj_set_loop(sound: ?*anyopaque, start_seconds: f32, end_seconds: f32) callconv(.c) void {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    const src = snd.source orelse return;
    const sr: f32 = @floatFromInt(src.sample_rate);
    src.loop_start_frame = @intFromFloat(start_seconds * sr);
    src.loop_end_frame = @intFromFloat(end_seconds * sr);
    src.loop_active = 1;
    const input_duration: f64 = @floatFromInt(src.loop_end_frame - src.loop_start_frame);
    src.loop_output_duration = @intFromFloat(input_duration * src.time_ratio);
    src.loop_output_tracking = 0;
    src.loop_output_wrap_point = src.output_frame_count;
    src.loop_measured = 0;
    src.loop_measured_duration = 0;
}

export fn dj_clear_loop(sound: ?*anyopaque) callconv(.c) void {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    const src = snd.source orelse return;
    src.loop_active = 0;
    src.loop_output_tracking = 0;
}

export fn dj_is_looping(sound: ?*anyopaque) callconv(.c) c_int {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    const src = snd.source orelse return 0;
    return src.loop_active;
}
