// automation.zig — Parameter automation (sample-rate interpolation)

const c = @import("c.zig");
const types = @import("types.zig");

export fn dj_set_automation(sound: ?*anyopaque, param: c_int, start_val: f32, end_val: f32, duration_seconds: f32, interp: c_int) callconv(.c) void {
    if (param < 0 or param >= types.DJ_PARAM_COUNT) return;
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    const p: usize = @intCast(param);
    var a = &snd.automations[p];

    a.start_value = start_val;
    a.end_value = end_val;
    a.interp = interp;

    if (snd.source) |src| {
        a.start_frame = src.output_frame_count;
        a.duration_frames = @intFromFloat(@as(f64, duration_seconds) * @as(f64, @floatFromInt(src.sample_rate)));
    } else {
        a.start_frame = 0;
        a.duration_frames = 0;
    }
    a.current_value = start_val;

    if (param == types.DJ_PARAM_FILTER) {
        snd.filter_value = start_val;
    } else if (param == types.DJ_PARAM_VOLUME) {
        c.ma_sound_set_volume(&snd.sound, start_val);
    } else if (param == types.DJ_PARAM_EQ_LO) {
        snd.eq_lo = start_val;
    } else if (param == types.DJ_PARAM_EQ_MID) {
        snd.eq_mid = start_val;
    } else if (param == types.DJ_PARAM_EQ_HI) {
        snd.eq_hi = start_val;
    }

    a.active = 1;
}

export fn dj_cancel_automation(sound: ?*anyopaque, param: c_int) callconv(.c) void {
    if (param < 0 or param >= types.DJ_PARAM_COUNT) return;
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    snd.automations[@intCast(param)].active = 0;
}

export fn dj_get_automation_value(sound: ?*anyopaque, param: c_int) callconv(.c) f32 {
    if (param < 0 or param >= types.DJ_PARAM_COUNT) return -1.0;
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return -1.0));
    const a = &snd.automations[@intCast(param)];
    if (a.active == 0) return -1.0;
    return a.current_value;
}

export fn dj_is_automation_active(sound: ?*anyopaque, param: c_int) callconv(.c) c_int {
    if (param < 0 or param >= types.DJ_PARAM_COUNT) return 0;
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    return snd.automations[@intCast(param)].active;
}
