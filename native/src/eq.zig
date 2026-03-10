// eq.zig — 3-band EQ set/get (gain 0..2, 1 = unity)

const types = @import("types.zig");

export fn dj_set_eq(sound: ?*anyopaque, lo: f32, mid: f32, hi: f32) callconv(.c) void {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    snd.eq_lo = lo;
    snd.eq_mid = mid;
    snd.eq_hi = hi;
    snd.automations[types.DJ_PARAM_EQ_LO].active = 0;
    snd.automations[types.DJ_PARAM_EQ_MID].active = 0;
    snd.automations[types.DJ_PARAM_EQ_HI].active = 0;
}

export fn dj_get_eq_lo(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 1.0));
    return snd.eq_lo;
}

export fn dj_get_eq_mid(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 1.0));
    return snd.eq_mid;
}

export fn dj_get_eq_hi(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 1.0));
    return snd.eq_hi;
}
