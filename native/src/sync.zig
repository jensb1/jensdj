// sync.zig — Global clock, sync_to_global_clock, sync_start, phase diffs

const std = @import("std");
const types = @import("types.zig");
const c = @import("c.zig");
const io_map = @import("io_map.zig");
const stretch = @import("stretch.zig");
const playback = @import("playback.zig");
const lifecycle = @import("lifecycle.zig");

fn getStderr() *anyopaque {
    return c.__stderrp;
}

pub export fn dj_set_global_clock(bar_duration: f32) callconv(.c) void {
    if (lifecycle.g_dj.global_engine == null or bar_duration <= 0) return;
    const engine = lifecycle.g_dj.global_engine.?;
    const sr = c.ma_engine_get_sample_rate(engine);
    lifecycle.g_dj.global_bar_duration = bar_duration;
    lifecycle.g_dj.global_bar_frames = @intFromFloat(bar_duration * @as(f32, @floatFromInt(sr)));
    lifecycle.g_dj.global_phase_origin = c.ma_engine_get_time_in_pcm_frames(engine);
    _ = c.fprintf(getStderr(), "[global_clock] set bar=%.4fs frames=%llu origin=%llu\n", bar_duration, lifecycle.g_dj.global_bar_frames, lifecycle.g_dj.global_phase_origin);
}

export fn dj_align_global_clock(sound: ?*anyopaque) callconv(.c) void {
    if (lifecycle.g_dj.global_engine == null or lifecycle.g_dj.global_bar_frames == 0) return;
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    const src = snd.source orelse return;
    const engine = lifecycle.g_dj.global_engine.?;
    const sr = c.ma_engine_get_sample_rate(engine);
    const time_ratio: f64 = if (src.time_ratio > 0.0) src.time_ratio else 1.0;

    const pos_output: f64 = @as(f64, @floatFromInt(src.output_frame_count)) / @as(f64, @floatFromInt(sr));
    const beat_ref_output: f64 = @as(f64, snd.beat_ref) * time_ratio;

    var track_phase = @rem(@as(f32, @floatCast(pos_output - beat_ref_output)), lifecycle.g_dj.global_bar_duration);
    if (track_phase < 0) track_phase += lifecycle.g_dj.global_bar_duration;

    const engine_time = c.ma_engine_get_time_in_pcm_frames(engine);
    const phase_frames: u64 = @intFromFloat(track_phase * @as(f32, @floatFromInt(sr)));
    lifecycle.g_dj.global_phase_origin = engine_time -% phase_frames;

    src.phase_active = 1;
}

export fn dj_set_beat_ref(sound: ?*anyopaque, beat_ref: f32) callconv(.c) void {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return));
    snd.beat_ref = beat_ref;
}

export fn dj_get_beat_ref(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    return snd.beat_ref;
}

export fn dj_get_global_phase() callconv(.c) f32 {
    if (lifecycle.g_dj.global_engine == null or lifecycle.g_dj.global_bar_frames == 0) return 0;
    const engine = lifecycle.g_dj.global_engine.?;
    const sr = c.ma_engine_get_sample_rate(engine);
    const engine_time = c.ma_engine_get_time_in_pcm_frames(engine);
    const phase_frames = (engine_time -% lifecycle.g_dj.global_phase_origin) % lifecycle.g_dj.global_bar_frames;
    return @as(f32, @floatFromInt(phase_frames)) / @as(f32, @floatFromInt(sr));
}

pub fn syncToGlobalClock(target: *types.DJSound, target_beat: f32) c_int {
    if (lifecycle.g_dj.global_engine == null or lifecycle.g_dj.global_bar_frames == 0) return -1;
    const src = target.source orelse return -1;
    const eng = target.engine orelse return -1;
    const sample_rate = c.ma_engine_get_sample_rate(&eng.engine);
    const time_ratio: f64 = if (src.time_ratio > 0.0) src.time_ratio else 1.0;

    const engine_time = c.ma_engine_get_time_in_pcm_frames(lifecycle.g_dj.global_engine.?);
    const global_phase_frames = (engine_time -% lifecycle.g_dj.global_phase_origin) % lifecycle.g_dj.global_bar_frames;
    const global_phase: f64 = @as(f64, @floatFromInt(global_phase_frames)) / @as(f64, @floatFromInt(sample_rate));

    var seek_input: f64 = @as(f64, target_beat) + global_phase / time_ratio;
    var effective_beat_ref: f32 = target_beat;

    // When a loop is active, wrap seek position into the loop boundaries.
    // The sync plan may pick a target_beat outside the loop — seeking there
    // causes the loop-wrap check to snap read_cursor to loop_start, creating
    // a phase offset (the modular remainder of the overshoot).
    if (src.loop_active != 0 and src.loop_end_frame > src.loop_start_frame) {
        const sr_f: f64 = @floatFromInt(sample_rate);
        const loop_start: f64 = @as(f64, @floatFromInt(src.loop_start_frame)) / sr_f;
        const loop_end: f64 = @as(f64, @floatFromInt(src.loop_end_frame)) / sr_f;
        const loop_dur: f64 = loop_end - loop_start;
        if (loop_dur > 0 and (seek_input < loop_start or seek_input >= loop_end)) {
            var offset = @rem(seek_input - loop_start, loop_dur);
            if (offset < 0) offset += loop_dur;
            seek_input = loop_start + offset;
        }
        // Use loop_start as beat reference so phase measurement stays
        // consistent across loop iterations.
        effective_beat_ref = @floatCast(loop_start);
    }

    target.beat_ref = effective_beat_ref;
    _ = playback.dj_seek(@ptrCast(target), @floatCast(seek_input));

    // Prefill RubberBand (respects loop boundaries)
    var need_frames: c_int = @intCast(src.rb_start_delay_remaining);
    need_frames += @intCast(lifecycle.g_dj.device_period_frames);
    if (need_frames < 480) need_frames = 480;

    var prefill_iters: c_int = 0;
    while (c.rubberband_available(src.rb) < need_frames and prefill_iters < 40) {
        // Wrap read_cursor at loop boundary before feeding
        if (src.loop_active != 0 and src.loop_end_frame > src.loop_start_frame and
            src.read_cursor >= src.loop_end_frame)
        {
            src.read_cursor = src.loop_start_frame;
        }

        var to_feed: u32 = types.RB_BLOCK_SIZE;
        if (src.read_cursor + to_feed > src.total_frames)
            to_feed = @intCast(src.total_frames - src.read_cursor);

        // Clamp to loop end
        if (src.loop_active != 0 and src.loop_end_frame > src.loop_start_frame) {
            if (src.read_cursor + to_feed > src.loop_end_frame)
                to_feed = @intCast(src.loop_end_frame - src.read_cursor);
        }
        if (to_feed == 0) break;

        for (0..to_feed) |fi| {
            for (0..src.channels) |ch| {
                if (src.deinterleaved_in[ch]) |buf| {
                    if (src.pcm_data) |pcm| {
                        buf[fi] = pcm[(src.read_cursor + fi) * src.channels + ch];
                    }
                }
            }
        }

        io_map.ioMapRecord(src);
        const is_final: c_int = if (src.loop_active != 0) 0 else if (src.read_cursor + to_feed >= src.total_frames) 1 else 0;
        c.rubberband_process(src.rb, @ptrCast(&src.deinterleaved_in), @intCast(to_feed), is_final);
        src.read_cursor += to_feed;
        prefill_iters += 1;
    }

    src.sync_pending = 1;
    src.sync_target_beat = effective_beat_ref;

    c.ma_sound_set_start_time_in_pcm_frames(&target.sound, 0);
    c.ma_sound_set_volume(&target.sound, target.volume);
    const r = c.ma_sound_start(&target.sound);
    if (r != types.MA_SUCCESS) return -1;

    src.phase_active = 1;
    return 0;
}

export fn dj_schedule_sync_play(target_sound: ?*anyopaque, target_seconds: f32, source_sound: ?*anyopaque, source_seconds: f32) callconv(.c) c_int {
    const target: *types.DJSound = @ptrCast(@alignCast(target_sound orelse return -1));
    const source: *types.DJSound = @ptrCast(@alignCast(source_sound orelse return -1));

    source.beat_ref = source_seconds;
    dj_align_global_clock(source_sound);

    if (source.original_bpm > 0 and target.original_bpm > 0) {
        const source_effective_bpm = source.original_bpm * @as(f32, @floatCast(1.0 / (if (source.source) |s| s.time_ratio else 1.0)));
        const ratio = source_effective_bpm / target.original_bpm;
        @import("tempo.zig").dj_set_tempo(target_sound, ratio);
    }

    const result = syncToGlobalClock(target, target_seconds);
    if (result == 0) target.scheduled = 0;
    return result;
}

pub export fn dj_sync_start(target_sound: ?*anyopaque, target_beat: f32, source_sound: ?*anyopaque, source_beat: f32, bar_duration: f32, preserve_transport: c_int) callconv(.c) c_int {
    _ = preserve_transport;
    const target: *types.DJSound = @ptrCast(@alignCast(target_sound orelse return -1));
    const source: *types.DJSound = @ptrCast(@alignCast(source_sound orelse return -1));

    _ = c.ma_sound_stop(&target.sound);
    c.ma_sound_set_start_time_in_pcm_frames(&target.sound, 0);
    target.scheduled = 0;

    if (source.original_bpm > 0 and target.original_bpm > 0) {
        const source_effective_bpm = source.original_bpm * @as(f32, @floatCast(1.0 / (if (source.source) |s| s.time_ratio else 1.0)));
        const ratio = source_effective_bpm / target.original_bpm;
        @import("tempo.zig").dj_set_tempo(target_sound, ratio);
    }

    source.beat_ref = source_beat;

    if (bar_duration > 0) {
        const clock_needs_setup = (lifecycle.g_dj.global_bar_frames == 0) or
            (@abs(lifecycle.g_dj.global_bar_duration - bar_duration) > 0.0001);
        if (clock_needs_setup) {
            dj_set_global_clock(bar_duration);
        }
        dj_align_global_clock(source_sound);
    }

    return syncToGlobalClock(target, target_beat);
}

export fn dj_cancel_scheduled_start(sound: ?*anyopaque) callconv(.c) c_int {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return -1));
    _ = c.ma_sound_stop(&snd.sound);
    c.ma_sound_set_start_time_in_pcm_frames(&snd.sound, 0);
    return 0;
}

export fn dj_get_track_sync_diff(sound: ?*anyopaque) callconv(.c) f32 {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    const src = snd.source orelse return 0;
    if (src.phase_active == 0) return 0;
    return @atomicLoad(f32, &src.phase_diff, .monotonic);
}

export fn dj_get_sync_diff(sound1: ?*anyopaque, sound2: ?*anyopaque, beat_ref: f32, bar_duration: f32) callconv(.c) f32 {
    _ = beat_ref;
    if (bar_duration <= 0) return 0;
    const s1: *types.DJSound = @ptrCast(@alignCast(sound1 orelse return 0));
    const s2: *types.DJSound = @ptrCast(@alignCast(sound2 orelse return 0));

    const s1_has = (s1.source != null and s1.source.?.phase_active != 0);
    const s2_has = (s2.source != null and s2.source.?.phase_active != 0);

    if (s1_has and s2_has) {
        const d1 = @atomicLoad(f32, &s1.source.?.phase_diff, .monotonic);
        const d2 = @atomicLoad(f32, &s2.source.?.phase_diff, .monotonic);
        return d1 - d2;
    } else if (s1_has) {
        return @atomicLoad(f32, &s1.source.?.phase_diff, .monotonic);
    } else if (s2_has) {
        return -@atomicLoad(f32, &s2.source.?.phase_diff, .monotonic);
    }

    const src1 = s1.source orelse return 0;
    const src2 = s2.source orelse return 0;
    const tr1: f64 = if (src1.time_ratio > 0.0) src1.time_ratio else 1.0;
    const tr2: f64 = if (src2.time_ratio > 0.0) src2.time_ratio else 1.0;
    const p1_out: f64 = @as(f64, @floatFromInt(src1.output_frame_count)) / @as(f64, @floatFromInt(src1.sample_rate));
    const p2_out: f64 = @as(f64, @floatFromInt(src2.output_frame_count)) / @as(f64, @floatFromInt(src2.sample_rate));
    var phase1 = @rem(@as(f32, @floatCast(p1_out - @as(f64, s1.beat_ref) * tr1)), bar_duration);
    var phase2 = @rem(@as(f32, @floatCast(p2_out - @as(f64, s2.beat_ref) * tr2)), bar_duration);
    if (phase1 < 0) phase1 += bar_duration;
    if (phase2 < 0) phase2 += bar_duration;
    var diff = phase1 - phase2;
    if (diff > bar_duration / 2) diff -= bar_duration;
    if (diff < -bar_duration / 2) diff += bar_duration;
    return diff;
}
