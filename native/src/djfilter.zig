// djfilter.zig — DJ filter knob (0.0 = full LP, 0.5 = bypass, 1.0 = full HP)

const types = @import("types.zig");

export fn dj_set_filter(sound: ?*anyopaque, value: f32) callconv(.c) void {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    snd.filter_value = @max(0.0, @min(1.0, value));
    snd.automations[types.DJ_PARAM_FILTER].active = 0;
}

export fn dj_get_filter(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0.5));
    return snd.filter_value;
}
