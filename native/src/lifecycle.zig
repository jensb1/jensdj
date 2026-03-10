// lifecycle.zig — dj_init/shutdown, device enumeration, engine create/destroy

const std = @import("std");
const types = @import("types.zig");
const c = @import("c.zig");

const c_alloc = std.heap.c_allocator;

// Global state
pub var g_dj: types.DJGlobal = .{};

export fn dj_init() callconv(.c) c_int {
    if (g_dj.initialized != 0) return 0;

    var result = c.ma_context_init(null, 0, null, &g_dj.context);
    if (result != types.MA_SUCCESS) return -1;

    var playback_infos: ?[*]types.MaDeviceInfo = null;
    var count: u32 = 0;
    result = c.ma_context_get_devices(&g_dj.context, &playback_infos, &count, null, null);
    if (result != types.MA_SUCCESS) {
        c.ma_context_uninit(&g_dj.context);
        return -2;
    }

    if (count > types.MAX_DEVICES) count = types.MAX_DEVICES;
    g_dj.playback_device_count = count;

    if (playback_infos) |infos| {
        const src = infos[0..count];
        @memcpy(g_dj.playback_devices[0..count], src);
    }

    g_dj.initialized = 1;
    return 0;
}

export fn dj_shutdown() callconv(.c) void {
    if (g_dj.initialized == 0) return;
    // Reset global engine state before uninit
    g_dj.global_engine = null;
    g_dj.global_bar_frames = 0;
    g_dj.global_bar_duration = 0;
    g_dj.global_phase_origin = 0;
    g_dj.device_period_frames = 0;
    c.ma_context_uninit(&g_dj.context);
    g_dj.initialized = 0;
}

export fn dj_get_device_count() callconv(.c) c_int {
    return @intCast(g_dj.playback_device_count);
}

export fn dj_get_device_name(index: c_int) callconv(.c) [*:0]const u8 {
    if (index < 0 or index >= @as(c_int, @intCast(g_dj.playback_device_count))) return "";
    return c.dj_c_device_info_name(&g_dj.playback_devices[@intCast(index)]);
}

export fn dj_get_device_channels(index: c_int) callconv(.c) c_int {
    if (index < 0 or index >= @as(c_int, @intCast(g_dj.playback_device_count))) return 0;
    return c.dj_c_device_info_channels(&g_dj.playback_devices[@intCast(index)]);
}

export fn dj_create_engine(device_index: c_int) callconv(.c) ?*anyopaque {
    const eng = c_alloc.create(types.DJEngine) catch return null;
    eng.* = .{};

    var config: types.MaEngineConfig = std.mem.zeroes(types.MaEngineConfig);
    c.dj_c_engine_config_init(&config);

    if (device_index >= 0 and device_index < @as(c_int, @intCast(g_dj.playback_device_count))) {
        const dev_id = c.dj_c_device_info_id(&g_dj.playback_devices[@intCast(device_index)]);
        c.dj_c_engine_config_set_device(&config, dev_id);
    }

    const result = c.ma_engine_init(@ptrCast(&config), &eng.engine);
    if (result != types.MA_SUCCESS) {
        c_alloc.destroy(eng);
        return null;
    }

    eng.device_index = device_index;
    if (g_dj.global_engine == null) {
        g_dj.global_engine = &eng.engine;
        g_dj.device_period_frames = c.dj_c_get_device_period(&eng.engine);
        const sr = c.ma_engine_get_sample_rate(&eng.engine);
        _ = c.fprintf(c.__stderrp, "[engine] device_period=%llu frames (%.1fms at %uHz)\n", g_dj.device_period_frames, @as(f32, @floatFromInt(g_dj.device_period_frames)) / @as(f32, @floatFromInt(sr)) * 1000.0, sr);
    }
    return @ptrCast(eng);
}

export fn dj_destroy_engine(engine: ?*anyopaque) callconv(.c) void {
    const eng: *types.DJEngine = @ptrCast(@alignCast(engine orelse return));
    if (g_dj.global_engine == &eng.engine) {
        g_dj.global_engine = null;
        g_dj.global_bar_frames = 0;
        g_dj.global_bar_duration = 0;
        g_dj.global_phase_origin = 0;
        g_dj.device_period_frames = 0;
    }
    c.ma_engine_uninit(&eng.engine);
    c_alloc.destroy(eng);
}
