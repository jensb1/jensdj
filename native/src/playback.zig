// playback.zig — Sound loading, play/pause/stop/seek, position, volume

const std = @import("std");
const types = @import("types.zig");
const c = @import("c.zig");
const stretch = @import("stretch.zig");
const lifecycle = @import("lifecycle.zig");

const c_alloc = std.heap.c_allocator;
fn getStderr() *anyopaque {
    return c.__stderrp;
}

pub fn clearPhaseTracking(snd: *types.DJSound) void {
    const src = snd.source orelse return;
    src.phase_active = 0;
    @atomicStore(f32, &src.phase_diff, @as(f32, 0.0), .monotonic);
}

export fn dj_load_sound(engine: ?*anyopaque, filepath: ?[*:0]const u8) callconv(.c) ?*anyopaque {
    const eng: *types.DJEngine = @ptrCast(@alignCast(engine orelse return null));
    const path = filepath orelse return null;

    var samplerate = c.ma_engine_get_sample_rate(&eng.engine);
    if (samplerate == 0) samplerate = 44100;

    const source = stretch.createStretchedSource(path, 2, samplerate) orelse return null;

    const snd = c_alloc.create(types.DJSound) catch {
        stretch.destroyStretchedSource(source);
        return null;
    };
    snd.* = .{};

    const result = c.ma_sound_init_from_data_source(
        &eng.engine,
        @ptrCast(&source.base),
        types.MA_SOUND_FLAG_NO_SPATIALIZATION,
        null,
        &snd.sound,
    );

    if (result != types.MA_SUCCESS) {
        stretch.destroyStretchedSource(source);
        c_alloc.destroy(snd);
        return null;
    }

    snd.engine = eng;
    snd.source = source;
    snd.volume = 1.0;
    snd.eq_lo = 1.0;
    snd.eq_mid = 1.0;
    snd.eq_hi = 1.0;
    snd.filter_value = 0.5;

    source.eq_lo_gain = &snd.eq_lo;
    source.eq_mid_gain = &snd.eq_mid;
    source.eq_hi_gain = &snd.eq_hi;
    source.djf_value = &snd.filter_value;
    source.owner = @ptrCast(snd);

    return @ptrCast(snd);
}

export fn dj_unload_sound(sound: ?*anyopaque) callconv(.c) void {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    // Free beat grid (managed by sync_engine)
    const sync_engine = @import("sync_engine.zig");
    sync_engine.freeBeatGrid(snd);
    c.ma_sound_uninit(&snd.sound);
    stretch.destroyStretchedSource(snd.source);
    c_alloc.destroy(snd);
}

export fn dj_play(sound: ?*anyopaque) callconv(.c) c_int {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return -1));
    const result = c.ma_sound_start(&snd.sound);
    _ = c.fprintf(getStderr(), "[dj_play] result=%d is_playing=%u\n", result, c.ma_sound_is_playing(&snd.sound));
    return if (result == types.MA_SUCCESS) 0 else -1;
}

export fn dj_pause(sound: ?*anyopaque) callconv(.c) c_int {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return -1));
    const paused_at = dj_get_position(sound);
    snd.scheduled = 0;
    clearPhaseTracking(snd);
    c.ma_sound_set_start_time_in_pcm_frames(&snd.sound, 0);
    const result = c.ma_sound_stop(&snd.sound);
    if (result == types.MA_SUCCESS) {
        _ = dj_seek(sound, paused_at);
    }
    return if (result == types.MA_SUCCESS) 0 else -1;
}

export fn dj_stop(sound: ?*anyopaque) callconv(.c) c_int {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return -1));
    snd.scheduled = 0;
    clearPhaseTracking(snd);
    _ = c.ma_sound_stop(&snd.sound);
    c.ma_sound_set_start_time_in_pcm_frames(&snd.sound, 0);
    _ = dj_seek(sound, 0.0);
    return 0;
}

pub export fn dj_seek(sound: ?*anyopaque, seconds: f32) callconv(.c) c_int {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return -1));
    const src = snd.source orelse return -1;

    var input_frame: u64 = @intFromFloat(@as(f64, seconds) * @as(f64, @floatFromInt(src.sample_rate)));
    if (input_frame > src.total_frames) input_frame = src.total_frames;
    const output_frame: u64 = @intFromFloat(@as(f64, @floatFromInt(input_frame)) * src.time_ratio);

    _ = stretch.stretchedSeekPub(src, output_frame);
    _ = c.ma_sound_seek_to_pcm_frame(&snd.sound, output_frame);
    return 0;
}

pub export fn dj_get_position(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    const src = snd.source orelse return 0;

    if (src.loop_active != 0 and src.loop_end_frame > src.loop_start_frame) {
        return @floatCast(@as(f64, @floatFromInt(src.read_cursor)) / @as(f64, @floatFromInt(src.sample_rate)));
    }

    const time_ratio: f64 = if (src.time_ratio > 0.0) src.time_ratio else 1.0;
    return @floatCast(@as(f64, @floatFromInt(src.output_frame_count)) / time_ratio / @as(f64, @floatFromInt(src.sample_rate)));
}

export fn dj_get_duration(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    var length: f32 = 0;
    _ = c.ma_sound_get_length_in_seconds(&snd.sound, &length);
    return length;
}

export fn dj_is_playing(sound: ?*anyopaque) callconv(.c) c_int {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    if (c.ma_sound_is_playing(&snd.sound) != 0) {
        snd.scheduled = 0;
        return 1;
    }
    return if (snd.scheduled != 0) 1 else 0;
}

export fn dj_set_volume(sound: ?*anyopaque, volume: f32) callconv(.c) void {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    snd.volume = volume;
    c.ma_sound_set_volume(&snd.sound, volume);
    snd.automations[types.DJ_PARAM_VOLUME].active = 0;
}
