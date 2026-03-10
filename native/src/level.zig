// level.zig — Level metering (RMS)

const c = @import("c.zig");
const types = @import("types.zig");

export fn dj_get_level(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    if (c.ma_sound_is_playing(&snd.sound) == 0) return 0;
    const src = snd.source orelse return 0;
    if (src.rms_count == 0) return 0;
    const rms: f32 = @floatCast(@sqrt(src.rms_sum / @as(f64, @floatFromInt(src.rms_count))));
    src.rms_sum = 0;
    src.rms_count = 0;
    return rms * snd.volume;
}
