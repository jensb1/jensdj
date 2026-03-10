// tempo.zig — Tempo control (RubberBand time-ratio)

const c = @import("c.zig");
const types = @import("types.zig");

pub export fn dj_set_tempo(sound: ?*anyopaque, ratio: f32) callconv(.c) void {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    const src = snd.source orelse return;
    if (src.rb == null) return;
    const rb_time_ratio: f64 = 1.0 / @as(f64, ratio);
    src.time_ratio = rb_time_ratio;
    c.rubberband_set_time_ratio(src.rb, rb_time_ratio);
    c.rubberband_set_pitch_scale(src.rb, 1.0);
}

pub export fn dj_get_tempo(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 1.0));
    const src = snd.source orelse return 1.0;
    return @floatCast(1.0 / src.time_ratio);
}

export fn dj_set_original_bpm(sound: ?*anyopaque, bpm: f32) callconv(.c) void {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    snd.original_bpm = bpm;
}

pub export fn dj_get_original_bpm(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    return snd.original_bpm;
}
