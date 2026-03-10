// analysis.zig — Peaks, BPM, beat detection, transients

const std = @import("std");
const types = @import("types.zig");
const c = @import("c.zig");
const filter = @import("filter.zig");

const CHUNK_SIZE = 4096;

export fn dj_get_peaks(filepath: ?[*:0]const u8, out_peaks: ?[*]f32, num_points: c_int) callconv(.c) c_int {
    const path = filepath orelse return -1;
    const peaks = out_peaks orelse return -1;
    if (num_points <= 0) return -1;
    const n: usize = @intCast(num_points);

    var decoder: types.MaDecoder = std.mem.zeroes(types.MaDecoder);
    var dconfig: types.MaDecoderConfig = undefined;
    c.dj_c_decoder_config_init(&dconfig, types.MA_FORMAT_F32, 1, 44100);
    if (c.ma_decoder_init_file(path, @ptrCast(&dconfig), &decoder) != types.MA_SUCCESS) return -1;

    var total_frames: u64 = 0;
    _ = c.ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);
    if (total_frames == 0) { _ = c.ma_decoder_uninit(&decoder); return -2; }

    const frames_per_point: f64 = @as(f64, @floatFromInt(total_frames)) / @as(f64, @floatFromInt(n));
    var buf: [CHUNK_SIZE]f32 = undefined;
    var point_index: usize = 0;
    var current_max: f32 = 0;
    var global_frame: u64 = 0;
    var next_boundary: f64 = frames_per_point;

    while (point_index < n) {
        var frames_read: u64 = 0;
        if (c.ma_decoder_read_pcm_frames(&decoder, &buf, CHUNK_SIZE, &frames_read) != types.MA_SUCCESS or frames_read == 0) break;

        for (0..@intCast(frames_read)) |i| {
            const val = @abs(buf[i]);
            if (val > current_max) current_max = val;
            global_frame += 1;
            if (@as(f64, @floatFromInt(global_frame)) >= next_boundary) {
                peaks[point_index] = current_max;
                point_index += 1;
                if (point_index >= n) break;
                current_max = 0;
                next_boundary = @as(f64, @floatFromInt(point_index + 1)) * frames_per_point;
            }
        }
    }
    while (point_index < n) {
        peaks[point_index] = current_max;
        point_index += 1;
        current_max = 0;
    }
    _ = c.ma_decoder_uninit(&decoder);
    return 0;
}

export fn dj_get_peaks_3band(filepath: ?[*:0]const u8, out_peaks: ?[*]f32, num_points: c_int) callconv(.c) c_int {
    const path = filepath orelse return -1;
    const peaks = out_peaks orelse return -1;
    if (num_points <= 0) return -1;
    const n: usize = @intCast(num_points);

    var decoder: types.MaDecoder = std.mem.zeroes(types.MaDecoder);
    var dconfig: types.MaDecoderConfig = undefined;
    c.dj_c_decoder_config_init(&dconfig, types.MA_FORMAT_F32, 1, 44100);
    if (c.ma_decoder_init_file(path, @ptrCast(&dconfig), &decoder) != types.MA_SUCCESS) return -1;

    var total_frames: u64 = 0;
    _ = c.ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);
    if (total_frames == 0) { _ = c.ma_decoder_uninit(&decoder); return -2; }

    const frames_per_point: f64 = @as(f64, @floatFromInt(total_frames)) / @as(f64, @floatFromInt(n));

    var lp1: types.LPFilter = .{};
    var lp2: types.LPFilter = .{};
    filter.lpInit(&lp1, 250.0, 44100.0);
    filter.lpInit(&lp2, 250.0, 44100.0);
    var hp1: types.HPFilter = .{};
    var hp2: types.HPFilter = .{};
    filter.hpInit(&hp1, 4000.0, 44100.0);
    filter.hpInit(&hp2, 4000.0, 44100.0);

    var buf: [CHUNK_SIZE]f32 = undefined;
    var point_index: usize = 0;
    var max_lo: f32 = 0;
    var max_mid: f32 = 0;
    var max_hi: f32 = 0;
    var global_frame: u64 = 0;
    var next_boundary: f64 = frames_per_point;

    while (point_index < n) {
        var frames_read: u64 = 0;
        if (c.ma_decoder_read_pcm_frames(&decoder, &buf, CHUNK_SIZE, &frames_read) != types.MA_SUCCESS or frames_read == 0) break;

        for (0..@intCast(frames_read)) |i| {
            const sample = buf[i];
            const lo = filter.lpProcess(&lp2, filter.lpProcess(&lp1, sample));
            const hi = filter.hpProcess(&hp2, filter.hpProcess(&hp1, sample));
            const mid = sample - lo - hi;
            const abs_lo = @abs(lo);
            const abs_mid = @abs(mid);
            const abs_hi = @abs(hi);
            if (abs_lo > max_lo) max_lo = abs_lo;
            if (abs_mid > max_mid) max_mid = abs_mid;
            if (abs_hi > max_hi) max_hi = abs_hi;
            global_frame += 1;
            if (@as(f64, @floatFromInt(global_frame)) >= next_boundary) {
                peaks[point_index * 3 + 0] = max_lo;
                peaks[point_index * 3 + 1] = max_mid;
                peaks[point_index * 3 + 2] = max_hi;
                point_index += 1;
                if (point_index >= n) break;
                max_lo = 0;
                max_mid = 0;
                max_hi = 0;
                next_boundary = @as(f64, @floatFromInt(point_index + 1)) * frames_per_point;
            }
        }
    }
    while (point_index < n) {
        peaks[point_index * 3 + 0] = max_lo;
        peaks[point_index * 3 + 1] = max_mid;
        peaks[point_index * 3 + 2] = max_hi;
        point_index += 1;
        max_lo = 0;
        max_mid = 0;
        max_hi = 0;
    }
    _ = c.ma_decoder_uninit(&decoder);
    return 0;
}

fn findPcmTransients(pcm: [*]const f32, total_frames: u64, out_times: [*]f32, max_out: usize) usize {
    var tl1: types.LPFilter = .{};
    var tl2: types.LPFilter = .{};
    filter.lpInit(&tl1, 200.0, @floatFromInt(types.BEAT_SAMPLERATE));
    filter.lpInit(&tl2, 200.0, @floatFromInt(types.BEAT_SAMPLERATE));

    var count: usize = 0;
    var last_time: f32 = -1.0;
    var in_transient: bool = false;
    var envelope: f32 = 0;
    const threshold: f32 = 0.02;
    const min_interval: f32 = 0.2;
    const attack: f32 = 0.005;
    const release: f32 = 0.0005;

    for (0..@intCast(total_frames)) |i| {
        if (count >= max_out) break;
        const filtered = filter.lpProcess(&tl2, filter.lpProcess(&tl1, pcm[i]));
        const sample = @abs(filtered);
        if (sample > envelope)
            envelope += attack * (sample - envelope)
        else
            envelope += release * (sample - envelope);

        const t: f32 = @as(f32, @floatFromInt(i)) / @as(f32, @floatFromInt(types.BEAT_SAMPLERATE));

        if (!in_transient and envelope > threshold) {
            if (last_time < 0 or (t - last_time) > min_interval) {
                out_times[count] = t;
                count += 1;
                last_time = t;
            }
            in_transient = true;
        } else if (in_transient and envelope < threshold * 0.5) {
            in_transient = false;
        }
    }
    return count;
}

export fn dj_find_transients(pcm: ?[*]const f32, num_frames: c_int, sample_rate: c_int, out_times: ?[*]f32, max_transients: c_int) callconv(.c) c_int {
    const pcm_data = pcm orelse return 0;
    const out = out_times orelse return 0;
    if (num_frames <= 0 or max_transients <= 0) return 0;

    var fl1: types.LPFilter = .{};
    var fl2: types.LPFilter = .{};
    filter.lpInit(&fl1, 200.0, @floatFromInt(sample_rate));
    filter.lpInit(&fl2, 200.0, @floatFromInt(sample_rate));

    var count: usize = 0;
    var last_time: f32 = -1.0;
    var in_transient: bool = false;
    var envelope: f32 = 0;
    const max_out: usize = @intCast(max_transients);

    for (0..@intCast(num_frames)) |i| {
        if (count >= max_out) break;
        const filtered = filter.lpProcess(&fl2, filter.lpProcess(&fl1, pcm_data[i]));
        const sample = @abs(filtered);
        if (sample > envelope)
            envelope += 0.005 * (sample - envelope)
        else
            envelope += 0.0005 * (sample - envelope);

        const t: f32 = @as(f32, @floatFromInt(i)) / @as(f32, @floatFromInt(sample_rate));
        if (!in_transient and envelope > 0.02) {
            if (last_time < 0 or (t - last_time) > 0.2) {
                out[count] = t;
                count += 1;
                last_time = t;
            }
            in_transient = true;
        } else if (in_transient and envelope < 0.01) {
            in_transient = false;
        }
    }
    return @intCast(count);
}

export fn dj_get_sample_rate(sound: ?*anyopaque) callconv(.c) c_int {
    const snd: *types.DJSound = @ptrCast(@alignCast(sound orelse return 0));
    const src = snd.source orelse return 0;
    return @intCast(src.sample_rate);
}

export fn dj_detect_bpm(filepath: ?[*:0]const u8) callconv(.c) f32 {
    const path = filepath orelse return 0;

    var decoder: types.MaDecoder = std.mem.zeroes(types.MaDecoder);
    var dconfig: types.MaDecoderConfig = undefined;
    c.dj_c_decoder_config_init(&dconfig, types.MA_FORMAT_F32, 1, types.BEAT_SAMPLERATE);
    if (c.ma_decoder_init_file(path, @ptrCast(&dconfig), &decoder) != types.MA_SUCCESS) return 0;

    var total_frames: u64 = 0;
    _ = c.ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);
    if (total_frames == 0) { _ = c.ma_decoder_uninit(&decoder); return 0; }

    const pcm: ?[*]f32 = @ptrCast(@alignCast(std.c.malloc(total_frames * @sizeOf(f32)) orelse {
        _ = c.ma_decoder_uninit(&decoder);
        return 0;
    }));
    defer std.c.free(@ptrCast(pcm.?));

    var frames_read: u64 = 0;
    _ = c.ma_decoder_read_pcm_frames(&decoder, pcm.?, total_frames, &frames_read);
    _ = c.ma_decoder_uninit(&decoder);

    var transients: [types.MAX_TRANSIENTS]f32 = undefined;
    const n_trans = findPcmTransients(pcm.?, frames_read, &transients, types.MAX_TRANSIENTS);

    if (n_trans >= 3) {
        var intervals: [types.MAX_TRANSIENTS]f32 = undefined;
        var n_iv: usize = 0;
        for (1..n_trans) |i| {
            const iv = transients[i] - transients[i - 1];
            if (iv >= 0.3 and iv <= 1.0) {
                intervals[n_iv] = iv;
                n_iv += 1;
            }
        }
        if (n_iv >= 2) {
            // Sort intervals
            for (0..n_iv - 1) |i| {
                for (i + 1..n_iv) |j| {
                    if (intervals[j] < intervals[i]) {
                        const tmp = intervals[i];
                        intervals[i] = intervals[j];
                        intervals[j] = tmp;
                    }
                }
            }
            const med = intervals[n_iv / 2];
            var csum: f64 = 0;
            var ccount: usize = 0;
            for (0..n_iv) |i| {
                if (@abs(intervals[i] - med) < 0.001) {
                    csum += intervals[i];
                    ccount += 1;
                }
            }
            return 60.0 / (if (ccount > 0) @as(f32, @floatCast(csum / @as(f64, @floatFromInt(ccount)))) else med);
        }
    }

    // Fallback: aubio tempo detection
    var dec2: types.MaDecoder = std.mem.zeroes(types.MaDecoder);
    if (c.ma_decoder_init_file(path, @ptrCast(&dconfig), &dec2) != types.MA_SUCCESS) return 0;

    const tempo_obj = c.new_aubio_tempo("default", 1024, 512, types.BEAT_SAMPLERATE) orelse {
        _ = c.ma_decoder_uninit(&dec2);
        return 0;
    };
    defer c.del_aubio_tempo(tempo_obj);

    const input = c.new_fvec(512) orelse {
        _ = c.ma_decoder_uninit(&dec2);
        return 0;
    };
    defer c.del_fvec(input);
    const output = c.new_fvec(1) orelse {
        _ = c.ma_decoder_uninit(&dec2);
        return 0;
    };
    defer c.del_fvec(output);

    var buf512: [512]f32 = undefined;
    var last_bpm: f32 = 0;

    while (true) {
        var fr: u64 = 0;
        if (c.ma_decoder_read_pcm_frames(&dec2, &buf512, 512, &fr) != types.MA_SUCCESS or fr == 0) break;
        const input_data = c.fvec_data(@ptrCast(input));
        for (0..@intCast(fr)) |i| input_data[i] = buf512[i];
        for (@intCast(fr)..512) |i| input_data[i] = 0;
        c.aubio_tempo_do(tempo_obj, input, output);
        const bpm = c.aubio_tempo_get_bpm(tempo_obj);
        if (bpm > 0) last_bpm = bpm;
    }
    _ = c.ma_decoder_uninit(&dec2);
    return last_bpm;
}

fn beatEnergy(energy: [*]const f32, n_energy: usize, duration: f64, interval: f64, phase: f64) f64 {
    var sum: f64 = 0;
    const window: i32 = 3;
    var t: f64 = phase;
    while (t < duration) : (t += interval) {
        const idx: i32 = @intFromFloat(t / duration * @as(f64, @floatFromInt(n_energy)));
        var j: i32 = -window;
        while (j <= window) : (j += 1) {
            const k = idx + j;
            if (k >= 0 and k < @as(i32, @intCast(n_energy)))
                sum += energy[@intCast(k)];
        }
    }
    return sum;
}

export fn dj_detect_beats(filepath: ?[*:0]const u8, out_beats: ?[*]f32, max_beats: c_int) callconv(.c) c_int {
    const path = filepath orelse return 0;
    const beats = out_beats orelse return 0;
    if (max_beats <= 0) return 0;

    var decoder: types.MaDecoder = std.mem.zeroes(types.MaDecoder);
    var dconfig: types.MaDecoderConfig = undefined;
    c.dj_c_decoder_config_init(&dconfig, types.MA_FORMAT_F32, 1, types.BEAT_SAMPLERATE);
    if (c.ma_decoder_init_file(path, @ptrCast(&dconfig), &decoder) != types.MA_SUCCESS) return 0;

    var total_frames: u64 = 0;
    _ = c.ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);
    if (total_frames == 0) { _ = c.ma_decoder_uninit(&decoder); return 0; }

    const duration: f64 = @as(f64, @floatFromInt(total_frames)) / @as(f64, types.BEAT_SAMPLERATE);

    const pcm: [*]f32 = @ptrCast(@alignCast(std.c.malloc(total_frames * @sizeOf(f32)) orelse {
        _ = c.ma_decoder_uninit(&decoder);
        return 0;
    }));
    defer std.c.free(@ptrCast(pcm));

    var frames_read: u64 = 0;
    _ = c.ma_decoder_read_pcm_frames(&decoder, pcm, total_frames, &frames_read);
    _ = c.ma_decoder_uninit(&decoder);
    if (frames_read == 0) return 0;

    // Step 1: rough BPM from transients
    var transients: [types.MAX_TRANSIENTS]f32 = undefined;
    const n_trans = findPcmTransients(pcm, frames_read, &transients, types.MAX_TRANSIENTS);

    var rough_bpm: f64 = 0;
    if (n_trans >= 3) {
        var intervals: [types.MAX_TRANSIENTS]f32 = undefined;
        var n_iv: usize = 0;
        for (1..n_trans) |i| {
            const iv = transients[i] - transients[i - 1];
            if (iv >= 0.3 and iv <= 1.0) { intervals[n_iv] = iv; n_iv += 1; }
        }
        if (n_iv >= 2) {
            for (0..n_iv - 1) |i| for (i + 1..n_iv) |j| {
                if (intervals[j] < intervals[i]) {
                    const tmp = intervals[i]; intervals[i] = intervals[j]; intervals[j] = tmp;
                }
            };
            rough_bpm = 60.0 / @as(f64, intervals[n_iv / 2]);
        }
    }
    if (rough_bpm <= 0) return 0;

    // Step 2: onset strength
    var el1: types.LPFilter = .{};
    var el2: types.LPFilter = .{};
    filter.lpInit(&el1, 250.0, @floatFromInt(types.BEAT_SAMPLERATE));
    filter.lpInit(&el2, 250.0, @floatFromInt(types.BEAT_SAMPLERATE));

    const energy_window: usize = types.BEAT_SAMPLERATE / 500;
    const n_energy: usize = @intCast(frames_read / energy_window);
    if (n_energy < 10) return 0;

    const raw_energy: [*]f32 = @ptrCast(@alignCast(std.c.calloc(n_energy, @sizeOf(f32)) orelse return 0));
    defer std.c.free(@ptrCast(raw_energy));
    const energy: [*]f32 = @ptrCast(@alignCast(std.c.calloc(n_energy, @sizeOf(f32)) orelse return 0));
    defer std.c.free(@ptrCast(energy));

    for (0..@intCast(frames_read)) |i| {
        const filtered = filter.lpProcess(&el2, filter.lpProcess(&el1, pcm[i]));
        const bin = i / energy_window;
        if (bin < n_energy) raw_energy[bin] += filtered * filtered;
    }

    energy[0] = 0;
    for (1..n_energy) |i| {
        const diff = raw_energy[i] - raw_energy[i - 1];
        energy[i] = if (diff > 0) diff else 0;
    }

    // Step 3: two-pass BPM + phase scan
    var best_interval: f64 = 60.0 / rough_bpm;
    var best_phase: f64 = 0;
    var best_score: f64 = 0;

    var bpm_try: f64 = rough_bpm - 2.0;
    while (bpm_try <= rough_bpm + 2.0) : (bpm_try += 0.05) {
        if (bpm_try <= 0) continue;
        const iv = 60.0 / bpm_try;
        const phase_steps: usize = @intFromFloat(iv * 500);
        for (0..phase_steps) |p| {
            const ph: f64 = @as(f64, @floatFromInt(p)) * 0.002;
            const score = beatEnergy(energy, n_energy, duration, iv, ph);
            if (score > best_score) { best_score = score; best_interval = iv; best_phase = ph; }
        }
    }

    const coarse_bpm = 60.0 / best_interval;
    const coarse_phase = best_phase;
    best_score = 0;

    bpm_try = coarse_bpm - 0.5;
    while (bpm_try <= coarse_bpm + 0.5) : (bpm_try += 0.001) {
        if (bpm_try <= 0) continue;
        const iv = 60.0 / bpm_try;
        var p: i32 = -10;
        while (p <= 10) : (p += 1) {
            var ph = coarse_phase + @as(f64, @floatFromInt(p)) * 0.0005;
            if (ph < 0) ph += iv;
            if (ph >= iv) ph -= iv;
            const score = beatEnergy(energy, n_energy, duration, iv, ph);
            if (score > best_score) { best_score = score; best_interval = iv; best_phase = ph; }
        }
    }

    // Pass 3: sample-level drift correction
    {
        var dec3: types.MaDecoder = std.mem.zeroes(types.MaDecoder);
        if (c.ma_decoder_init_file(path, @ptrCast(&dconfig), &dec3) == types.MA_SUCCESS) {
            var tf3: u64 = 0;
            _ = c.ma_decoder_get_length_in_pcm_frames(&dec3, &tf3);
            if (std.c.malloc(tf3 * @sizeOf(f32))) |pcm3_raw| {
                const pcm3: [*]f32 = @ptrCast(@alignCast(pcm3_raw));
                defer std.c.free(pcm3_raw);
                var fr3: u64 = 0;
                _ = c.ma_decoder_read_pcm_frames(&dec3, pcm3, tf3, &fr3);

                var dl1: types.LPFilter = .{};
                var dl2: types.LPFilter = .{};
                filter.lpInit(&dl1, 250.0, @floatFromInt(types.BEAT_SAMPLERATE));
                filter.lpInit(&dl2, 250.0, @floatFromInt(types.BEAT_SAMPLERATE));
                for (0..@intCast(fr3)) |i| pcm3[i] = filter.lpProcess(&dl2, filter.lpProcess(&dl1, pcm3[i]));

                var global_max: f32 = 0;
                for (0..@intCast(fr3)) |i| { const v = @abs(pcm3[i]); if (v > global_max) global_max = v; }
                const thresh: f32 = global_max * 0.3;
                const search_samples: i32 = @intCast(types.BEAT_SAMPLERATE / 10);

                for (0..3) |_| {
                    var sx: f64 = 0;
                    var sy: f64 = 0;
                    var sxy: f64 = 0;
                    var sx2: f64 = 0;
                    var n3: usize = 0;
                    var beat_idx: usize = 0;
                    var t: f64 = best_phase;
                    while (t < duration) : (t += best_interval) {
                        const center: i64 = @intFromFloat(t * @as(f64, types.BEAT_SAMPLERATE));
                        var peak_val: f32 = 0;
                        var peak_off: i32 = 0;
                        var j: i32 = -search_samples;
                        while (j <= search_samples) : (j += 1) {
                            const k = center + j;
                            if (k >= 0 and k < @as(i64, @intCast(fr3))) {
                                const v = @abs(pcm3[@intCast(k)]);
                                if (v > peak_val) { peak_val = v; peak_off = j; }
                            }
                        }
                        if (peak_val > thresh) {
                            const x: f64 = @floatFromInt(beat_idx);
                            const y: f64 = @as(f64, @floatFromInt(peak_off)) / @as(f64, types.BEAT_SAMPLERATE);
                            sx += x; sy += y; sxy += x * y; sx2 += x * x;
                            n3 += 1;
                        }
                        beat_idx += 1;
                    }
                    if (n3 >= 20) {
                        const nd: f64 = @floatFromInt(n3);
                        const drift = (nd * sxy - sx * sy) / (nd * sx2 - sx * sx);
                        const intercept = (sy - drift * sx) / nd;
                        best_interval += drift;
                        best_phase += intercept;
                        while (best_phase < 0) best_phase += best_interval;
                        while (best_phase >= best_interval) best_phase -= best_interval;
                    }
                }
            }
            _ = c.ma_decoder_uninit(&dec3);
        }
    }

    // Step 4: generate grid
    var beat_count: usize = 0;
    var t: f64 = best_phase;
    while (t < duration and beat_count < @as(usize, @intCast(max_beats))) {
        beats[beat_count] = @floatCast(t);
        beat_count += 1;
        t += best_interval;
    }
    return @intCast(beat_count);
}
