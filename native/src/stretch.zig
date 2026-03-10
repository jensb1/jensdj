// stretch.zig — RubberBand pipeline, stretched_read audio callback, create/destroy

const std = @import("std");
const types = @import("types.zig");
const c = @import("c.zig");
const filter = @import("filter.zig");
const io_map = @import("io_map.zig");
const lifecycle = @import("lifecycle.zig");

const c_alloc = std.heap.c_allocator;
fn getStderr() *anyopaque {
    return c.__stderrp;
}

/// Prime RubberBand with silence to fill the start pad
pub fn rbPrime(src: *types.DJStretchedSource) void {
    const pad = c.rubberband_get_preferred_start_pad(src.rb);
    if (pad > 0) {
        var silence: [types.RB_BLOCK_SIZE]f32 = std.mem.zeroes([types.RB_BLOCK_SIZE]f32);
        var silence_ptrs: [types.MAX_CHANNELS]?[*]const f32 = undefined;
        for (0..src.channels) |ch| silence_ptrs[ch] = &silence;

        var fed: c_uint = 0;
        while (fed < pad) {
            var chunk = pad - fed;
            if (chunk > types.RB_BLOCK_SIZE) chunk = types.RB_BLOCK_SIZE;
            c.rubberband_process(src.rb, @ptrCast(&silence_ptrs), chunk, 0);
            fed += chunk;
        }
    }
    src.rb_start_delay_remaining = c.rubberband_get_start_delay(src.rb);
}

/// Data source read callback — called by miniaudio on audio thread.
/// Safety checks disabled: audio callbacks must never panic (real-time thread).
/// The C version relied on unsigned wrapping; Zig Debug mode would panic instead.
fn stretchedRead(pDataSource: ?*anyopaque, pFramesOut: ?*anyopaque, frameCount: u64, pFramesRead: ?*u64) callconv(.c) c_int {
    @setRuntimeSafety(false);
    const src: *types.DJStretchedSource = @ptrCast(@alignCast(pDataSource orelse {
        if (pFramesRead) |pr| pr.* = 0;
        return types.MA_AT_END;
    }));
    const out: [*]f32 = @ptrCast(@alignCast(pFramesOut orelse {
        if (pFramesRead) |pr| pr.* = 0;
        return types.MA_AT_END;
    }));
    var frames_written: u64 = 0;

    // Handle sync_pending — recalculate output_frame_count to match global clock phase.
    if (src.sync_pending != 0 and lifecycle.g_dj.global_engine != null and lifecycle.g_dj.global_bar_frames > 0) {
        src.sync_pending = 0;
        const engine_time = c.ma_engine_get_time_in_pcm_frames(lifecycle.g_dj.global_engine.?);
        const phase_frames = (engine_time -% lifecycle.g_dj.global_phase_origin) % lifecycle.g_dj.global_bar_frames;
        const global_phase: f64 = @as(f64, @floatFromInt(phase_frames)) / @as(f64, @floatFromInt(src.sample_rate));
        const time_ratio: f64 = if (src.time_ratio > 0.0) src.time_ratio else 1.0;
        var seek_input: f64 = @as(f64, src.sync_target_beat) + global_phase / time_ratio;

        // Wrap within loop boundaries (same logic as syncToGlobalClock)
        if (src.loop_active != 0 and src.loop_end_frame > src.loop_start_frame) {
            const sr_f: f64 = @floatFromInt(src.sample_rate);
            const loop_start: f64 = @as(f64, @floatFromInt(src.loop_start_frame)) / sr_f;
            const loop_end: f64 = @as(f64, @floatFromInt(src.loop_end_frame)) / sr_f;
            const loop_dur: f64 = loop_end - loop_start;
            if (loop_dur > 0 and (seek_input < loop_start or seek_input >= loop_end)) {
                var offset = @rem(seek_input - loop_start, loop_dur);
                if (offset < 0) offset += loop_dur;
                seek_input = loop_start + offset;
            }
        }

        const input_frame: u64 = @intFromFloat(seek_input * @as(f64, @floatFromInt(src.sample_rate)));
        src.output_frame_count = @intFromFloat(@as(f64, @floatFromInt(input_frame)) * time_ratio);
        src.phase_diag_remaining = 10;
    }

    while (frames_written < frameCount) {
        const available = c.rubberband_available(src.rb);
        if (available > 0) {
            const to_retrieve: c_uint = @intCast(@min(frameCount - frames_written, @as(u64, @intCast(available))));

            var retrieved = c.rubberband_retrieve(src.rb, @ptrCast(&src.deinterleaved_out), to_retrieve);

            // Skip start delay
            if (src.rb_start_delay_remaining > 0) {
                const to_skip: c_uint = @intCast(@min(src.rb_start_delay_remaining, retrieved));
                if (to_skip < retrieved) {
                    for (0..src.channels) |ch| {
                        if (src.deinterleaved_out[ch]) |out_ch| {
                            const remaining = retrieved - to_skip;
                            var i: c_uint = 0;
                            while (i < remaining) : (i += 1) {
                                out_ch[i] = out_ch[i + to_skip];
                            }
                        }
                    }
                }
                retrieved -= to_skip;
                src.rb_start_delay_remaining -= to_skip;
                if (retrieved == 0) continue;
            }

            // DJ filter init/update
            var djf_val: f32 = if (src.djf_value) |v| v.* else 0.5;
            var djf_active: bool = (djf_val < 0.49 or djf_val > 0.51);
            if (djf_active and (src.djf_initialized == 0 or @abs(djf_val - src.djf_last_value) > 0.001)) {
                const sr: f32 = @floatFromInt(src.sample_rate);
                if (djf_val < 0.5) {
                    const t = djf_val / 0.5;
                    const cutoff = 100.0 * std.math.pow(f32, 200.0, t);
                    for (0..src.channels) |ch_| {
                        filter.lpInit(&src.djf_lp[ch_][0], cutoff, sr);
                        filter.lpInit(&src.djf_lp[ch_][1], cutoff, sr);
                    }
                } else {
                    const t = (djf_val - 0.5) / 0.5;
                    const cutoff = 20.0 * std.math.pow(f32, 250.0, t);
                    for (0..src.channels) |ch_| {
                        filter.hpInit(&src.djf_hp[ch_][0], cutoff, sr);
                        filter.hpInit(&src.djf_hp[ch_][1], cutoff, sr);
                    }
                }
                src.djf_last_value = djf_val;
                src.djf_initialized = 1;
            }

            // Process automation
            if (src.owner) |owner_ptr| {
                const auto_snd: *types.DJSound = @ptrCast(@alignCast(owner_ptr));
                const chunk_mid = src.output_frame_count + retrieved / 2;
                for (0..types.DJ_PARAM_COUNT) |p| {
                    var a = &auto_snd.automations[p];
                    if (a.active == 0) continue;
                    var t: f32 = undefined;
                    if (a.duration_frames == 0) {
                        t = 1.0;
                    } else if (chunk_mid >= a.start_frame + a.duration_frames) {
                        t = 1.0;
                    } else if (chunk_mid <= a.start_frame) {
                        t = 0.0;
                    } else {
                        t = @as(f32, @floatFromInt(chunk_mid - a.start_frame)) / @as(f32, @floatFromInt(a.duration_frames));
                    }
                    switch (a.interp) {
                        types.DJ_INTERP_EASE_IN => t = t * t,
                        types.DJ_INTERP_EASE_OUT => t = 1.0 - (1.0 - t) * (1.0 - t),
                        else => {},
                    }
                    const val = a.start_value + (a.end_value - a.start_value) * t;
                    a.current_value = val;
                    if (p == types.DJ_PARAM_FILTER) {
                        auto_snd.filter_value = val;
                    } else if (p == types.DJ_PARAM_VOLUME) {
                        auto_snd.volume = val;
                        c.ma_sound_set_volume(&auto_snd.sound, val);
                    } else if (p == types.DJ_PARAM_EQ_LO) {
                        auto_snd.eq_lo = val;
                    } else if (p == types.DJ_PARAM_EQ_MID) {
                        auto_snd.eq_mid = val;
                    } else if (p == types.DJ_PARAM_EQ_HI) {
                        auto_snd.eq_hi = val;
                    }
                    if (a.duration_frames == 0 or chunk_mid >= a.start_frame + a.duration_frames) {
                        a.active = 0;
                    }
                }
                // Re-check DJ filter after automation
                djf_val = if (src.djf_value) |v| v.* else 0.5;
                djf_active = (djf_val < 0.49 or djf_val > 0.51);
                if (djf_active and (src.djf_initialized == 0 or @abs(djf_val - src.djf_last_value) > 0.001)) {
                    const sr: f32 = @floatFromInt(src.sample_rate);
                    if (djf_val < 0.5) {
                        const ft = djf_val / 0.5;
                        const cutoff = 100.0 * std.math.pow(f32, 200.0, ft);
                        for (0..src.channels) |ch_| {
                            filter.lpInit(&src.djf_lp[ch_][0], cutoff, sr);
                            filter.lpInit(&src.djf_lp[ch_][1], cutoff, sr);
                        }
                    } else {
                        const ft = (djf_val - 0.5) / 0.5;
                        const cutoff = 20.0 * std.math.pow(f32, 250.0, ft);
                        for (0..src.channels) |ch_| {
                            filter.hpInit(&src.djf_hp[ch_][0], cutoff, sr);
                            filter.hpInit(&src.djf_hp[ch_][1], cutoff, sr);
                        }
                    }
                    src.djf_last_value = djf_val;
                    src.djf_initialized = 1;
                }
            }

            // EQ + filter processing
            const lo_g: f32 = if (src.eq_lo_gain) |g| g.* else 1.0;
            const mi_g: f32 = if (src.eq_mid_gain) |g| g.* else 1.0;
            const hi_g: f32 = if (src.eq_hi_gain) |g| g.* else 1.0;

            var i: u32 = 0;
            while (i < retrieved) : (i += 1) {
                for (0..src.channels) |ch| {
                    const sample = if (src.deinterleaved_out[ch]) |buf| buf[i] else 0;
                    const lo = filter.lpProcess(&src.eq_lo_lp[ch][1], filter.lpProcess(&src.eq_lo_lp[ch][0], sample));
                    const hi = filter.hpProcess(&src.eq_hi_hp[ch][1], filter.hpProcess(&src.eq_hi_hp[ch][0], sample));
                    const mid = sample - lo - hi;
                    var result = lo * lo_g + mid * mi_g + hi * hi_g;
                    if (djf_active) {
                        if (djf_val < 0.5) {
                            result = filter.lpProcess(&src.djf_lp[ch][1], filter.lpProcess(&src.djf_lp[ch][0], result));
                        } else {
                            result = filter.hpProcess(&src.djf_hp[ch][1], filter.hpProcess(&src.djf_hp[ch][0], result));
                        }
                    }
                    out[(frames_written + i) * src.channels + ch] = result;
                    src.rms_sum += @as(f64, result) * @as(f64, result);
                    src.rms_count += 1;
                }
            }
            src.output_frame_count += retrieved;
            frames_written += retrieved;
            continue;
        }

        // Loop handling
        if (src.loop_active != 0 and src.read_cursor >= src.loop_end_frame and
            src.loop_end_frame > src.loop_start_frame)
        {
            if (src.loop_measured == 0 and src.loop_output_wrap_point > 0 and
                src.output_frame_count >= src.loop_output_wrap_point)
            {
                src.loop_measured_duration = src.output_frame_count - src.loop_output_wrap_point;
                src.loop_measured = 1;
            }
            src.read_cursor = src.loop_start_frame;
            src.loop_output_wrap_point = src.output_frame_count;
        }

        if (src.read_cursor >= src.total_frames) break;

        var to_feed: u32 = types.RB_BLOCK_SIZE;
        if (src.read_cursor + to_feed > src.total_frames)
            to_feed = @intCast(src.total_frames - src.read_cursor);

        if (src.loop_active != 0 and src.loop_end_frame > src.loop_start_frame) {
            if (src.read_cursor + to_feed > src.loop_end_frame) {
                to_feed = @intCast(src.loop_end_frame - src.read_cursor);
                if (to_feed == 0) {
                    src.read_cursor = src.loop_start_frame;
                    continue;
                }
            }
        }

        // Deinterleave
        for (0..to_feed) |fi| {
            for (0..src.channels) |ch| {
                if (src.deinterleaved_in[ch]) |buf| {
                    if (src.pcm_data) |pcm| {
                        buf[fi] = pcm[(src.read_cursor + fi) * src.channels + ch];
                    }
                }
            }
        }

        const is_final: c_int = if (src.loop_active != 0) 0 else if (src.read_cursor + to_feed >= src.total_frames) 1 else 0;
        io_map.ioMapRecord(src);
        c.rubberband_process(src.rb, @ptrCast(&src.deinterleaved_in), @intCast(to_feed), is_final);
        src.read_cursor += to_feed;
    }

    // Phase measurement against global beat clock
    if (src.phase_active != 0 and lifecycle.g_dj.global_bar_frames > 0 and lifecycle.g_dj.global_engine != null) {
        const pos_output: f64 = @as(f64, @floatFromInt(src.output_frame_count)) / @as(f64, @floatFromInt(src.sample_rate));
        const owner: ?*types.DJSound = if (src.owner) |o| @ptrCast(@alignCast(o)) else null;
        const beat_ref_output: f64 = if (owner) |o| @as(f64, o.beat_ref) * src.time_ratio else 0.0;
        const bar_duration = lifecycle.g_dj.global_bar_duration;
        var track_phase = @rem(@as(f32, @floatCast(pos_output - beat_ref_output)), bar_duration);
        if (track_phase < 0) track_phase += bar_duration;

        const engine_time = c.ma_engine_get_time_in_pcm_frames(lifecycle.g_dj.global_engine.?);
        const global_phase_frames = (engine_time -% lifecycle.g_dj.global_phase_origin) % lifecycle.g_dj.global_bar_frames;
        const global_phase: f32 = @as(f32, @floatFromInt(global_phase_frames)) / @as(f32, @floatFromInt(src.sample_rate));

        var diff = track_phase - global_phase;
        if (diff > bar_duration / 2) diff -= bar_duration;
        if (diff < -bar_duration / 2) diff += bar_duration;
        @atomicStore(f32, &src.phase_diff, diff, .monotonic);
        _ = @atomicRmw(u64, &src.phase_diff_gen, .Add, 1, .monotonic);

        if (src.phase_diag_remaining > 0) {
            src.phase_diag_remaining -= 1;
        }
    }

    if (pFramesRead) |pr| pr.* = frames_written;
    return if (frames_written > 0) types.MA_SUCCESS else types.MA_AT_END;
}

fn stretchedSeek(pDataSource: ?*anyopaque, frameIndex: u64) callconv(.c) c_int {
    const src: *types.DJStretchedSource = @ptrCast(@alignCast(pDataSource orelse return types.MA_ERROR));
    if (src.output_frame_count == frameIndex) return types.MA_SUCCESS;

    const input_frame: u64 = @intFromFloat(@as(f64, @floatFromInt(frameIndex)) / src.time_ratio);
    src.read_cursor = @min(input_frame, src.total_frames);
    src.output_frame_count = frameIndex;

    c.rubberband_reset(src.rb);
    rbPrime(src);

    io_map.ioMapReset(src);
    io_map.ioMapRecord(src);

    return types.MA_SUCCESS;
}

/// Public wrapper for playback.zig to call seek on a stretched source.
pub fn stretchedSeekPub(src: *types.DJStretchedSource, frameIndex: u64) c_int {
    return stretchedSeek(@ptrCast(src), frameIndex);
}

fn stretchedGetDataFormat(pDataSource: ?*anyopaque, pFormat: ?*c_int, pChannels: ?*u32, pSampleRate: ?*u32, pChannelMap: ?*u8, channelMapCap: usize) callconv(.c) c_int {
    const src: *types.DJStretchedSource = @ptrCast(@alignCast(pDataSource orelse return types.MA_ERROR));
    if (pFormat) |f| f.* = types.MA_FORMAT_F32;
    if (pChannels) |ch| ch.* = src.channels;
    if (pSampleRate) |sr| sr.* = src.sample_rate;
    if (pChannelMap) |cm| {
        c.ma_channel_map_init_standard(types.MA_STANDARD_CHANNEL_MAP_DEFAULT, @ptrCast(cm), channelMapCap, src.channels);
    }
    return types.MA_SUCCESS;
}

fn stretchedGetCursor(pDataSource: ?*anyopaque, pCursor: ?*u64) callconv(.c) c_int {
    const src: *types.DJStretchedSource = @ptrCast(@alignCast(pDataSource orelse return types.MA_ERROR));
    if (pCursor) |cur| cur.* = src.output_frame_count;
    return types.MA_SUCCESS;
}

fn stretchedGetLength(pDataSource: ?*anyopaque, pLength: ?*u64) callconv(.c) c_int {
    const src: *types.DJStretchedSource = @ptrCast(@alignCast(pDataSource orelse return types.MA_ERROR));
    if (pLength) |len| len.* = @intFromFloat(@as(f64, @floatFromInt(src.total_frames)) * src.time_ratio);
    return types.MA_SUCCESS;
}

/// Vtable for miniaudio data source
pub var g_stretched_vtable: types.MaDataSourceVtable = .{
    .onRead = &stretchedRead,
    .onSeek = &stretchedSeek,
    .onGetDataFormat = &stretchedGetDataFormat,
    .onGetCursor = &stretchedGetCursor,
    .onGetLength = &stretchedGetLength,
};

/// Create a new stretched source by decoding an audio file
pub fn createStretchedSource(filepath: [*:0]const u8, target_channels: u32, target_samplerate: u32) ?*types.DJStretchedSource {
    var decoder: types.MaDecoder = std.mem.zeroes(types.MaDecoder);
    var dconfig: types.MaDecoderConfig = undefined;
    c.dj_c_decoder_config_init(&dconfig, types.MA_FORMAT_F32, target_channels, target_samplerate);

    if (c.ma_decoder_init_file(filepath, @ptrCast(&dconfig), &decoder) != types.MA_SUCCESS) return null;

    var total_frames: u64 = 0;
    _ = c.ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);
    if (total_frames == 0) {
        _ = c.ma_decoder_uninit(&decoder);
        return null;
    }

    const pcm = @as(?[*]f32, @ptrCast(@alignCast(std.c.malloc(total_frames * target_channels * @sizeOf(f32)) orelse {
        _ = c.ma_decoder_uninit(&decoder);
        return null;
    })));

    var frames_read: u64 = 0;
    _ = c.ma_decoder_read_pcm_frames(&decoder, pcm.?, total_frames, &frames_read);
    _ = c.ma_decoder_uninit(&decoder);

    if (frames_read == 0) {
        std.c.free(@ptrCast(pcm.?));
        return null;
    }

    const src = c_alloc.create(types.DJStretchedSource) catch {
        std.c.free(@ptrCast(pcm.?));
        return null;
    };
    src.* = .{};

    src.pcm_data = pcm;
    src.total_frames = frames_read;
    src.channels = target_channels;
    src.sample_rate = target_samplerate;
    src.time_ratio = 1.0;
    src.pitch_scale = 1.0;

    for (0..target_channels) |ch| {
        src.deinterleaved_in[ch] = @ptrCast(@alignCast(std.c.malloc(types.RB_BLOCK_SIZE * @sizeOf(f32)) orelse {
            destroyStretchedSource(src);
            return null;
        }));
        src.deinterleaved_out[ch] = @ptrCast(@alignCast(std.c.malloc(types.RB_BLOCK_SIZE * @sizeOf(f32)) orelse {
            destroyStretchedSource(src);
            return null;
        }));
    }

    const opts: c_int = types.RB_OPTION_PROCESS_REALTIME | types.RB_OPTION_ENGINE_FINER | types.RB_OPTION_THREADING_NEVER;
    src.rb = c.rubberband_new(target_samplerate, target_channels, opts, 1.0, 1.0);
    c.rubberband_set_max_process_size(src.rb, types.RB_BLOCK_SIZE);

    rbPrime(src);

    // Init EQ filters
    for (0..target_channels) |ch| {
        const sr: f32 = @floatFromInt(target_samplerate);
        filter.lpInit(&src.eq_lo_lp[ch][0], 500.0, sr);
        filter.lpInit(&src.eq_lo_lp[ch][1], 500.0, sr);
        filter.hpInit(&src.eq_hi_hp[ch][0], 2500.0, sr);
        filter.hpInit(&src.eq_hi_hp[ch][1], 2500.0, sr);
    }

    src.djf_last_value = 0.5;
    io_map.ioMapReset(src);
    @atomicStore(f32, &src.phase_diff, @as(f32, 0.0), .monotonic);
    @atomicStore(u64, &src.phase_diff_gen, @as(u64, 0), .monotonic);

    // Init data source base with vtable
    var base_config: types.MaDataSourceConfig = undefined;
    c.dj_c_data_source_config_init(&base_config, &g_stretched_vtable);
    _ = c.ma_data_source_init(@ptrCast(&base_config), &src.base);

    return src;
}

/// Destroy a stretched source and free all resources
pub fn destroyStretchedSource(src: ?*types.DJStretchedSource) void {
    const s = src orelse return;
    if (s.rb != null) c.rubberband_delete(s.rb);
    for (0..s.channels) |ch| {
        if (s.deinterleaved_in[ch]) |buf| std.c.free(@ptrCast(buf));
        if (s.deinterleaved_out[ch]) |buf| std.c.free(@ptrCast(buf));
    }
    if (s.pcm_data) |pcm| std.c.free(@ptrCast(pcm));
    c_alloc.destroy(s);
}

/// Pull processed frames offline (for testing)
export fn dj_pull_frames(sound: ?*anyopaque, buffer: ?*anyopaque, num_frames: c_int) callconv(.c) c_int {
    if (num_frames <= 0) return 0;
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    const source = snd.source orelse return 0;
    var frames_read: u64 = 0;
    _ = stretchedRead(@ptrCast(source), buffer, @intCast(num_frames), &frames_read);
    return @intCast(frames_read);
}
