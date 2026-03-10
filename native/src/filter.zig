// filter.zig — Butterworth LP/HP filters (2nd order)
// Hot-path process functions are inline for zero-cost in audio callback.

const std = @import("std");
const types = @import("types.zig");

/// Initialize low-pass Butterworth filter (Q = sqrt(2)/2 ≈ 0.7071)
pub fn lpInit(f: *types.LPFilter, cutoff_hz: f32, samplerate: f32) void {
    const w0 = 2.0 * std.math.pi * @as(f64, cutoff_hz) / @as(f64, samplerate);
    const cosw0: f32 = @floatCast(@cos(w0));
    const sinw0: f32 = @floatCast(@sin(w0));
    const alpha = sinw0 / (2.0 * 0.7071);
    const a0 = 1.0 + alpha;
    f.b0 = ((1.0 - cosw0) / 2.0) / a0;
    f.b1 = (1.0 - cosw0) / a0;
    f.b2 = f.b0;
    f.a1 = (-2.0 * cosw0) / a0;
    f.a2 = (1.0 - alpha) / a0;
    f.x1 = 0;
    f.x2 = 0;
    f.y1 = 0;
    f.y2 = 0;
}

/// Initialize high-pass Butterworth filter (Q = sqrt(2)/2 ≈ 0.7071)
pub fn hpInit(f: *types.HPFilter, cutoff_hz: f32, samplerate: f32) void {
    const w0 = 2.0 * std.math.pi * @as(f64, cutoff_hz) / @as(f64, samplerate);
    const cosw0: f32 = @floatCast(@cos(w0));
    const sinw0: f32 = @floatCast(@sin(w0));
    const alpha = sinw0 / (2.0 * 0.7071);
    const a0 = 1.0 + alpha;
    f.b0 = ((1.0 + cosw0) / 2.0) / a0;
    f.b1 = -(1.0 + cosw0) / a0;
    f.b2 = f.b0;
    f.a1 = (-2.0 * cosw0) / a0;
    f.a2 = (1.0 - alpha) / a0;
    f.x1 = 0;
    f.x2 = 0;
    f.y1 = 0;
    f.y2 = 0;
}

/// Process one sample through low-pass filter (hot path, inline)
pub inline fn lpProcess(f: *types.LPFilter, x: f32) f32 {
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
    f.x2 = f.x1;
    f.x1 = x;
    f.y2 = f.y1;
    f.y1 = y;
    return y;
}

/// Process one sample through high-pass filter (hot path, inline)
pub inline fn hpProcess(f: *types.HPFilter, x: f32) f32 {
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
    f.x2 = f.x1;
    f.x1 = x;
    f.y2 = f.y1;
    f.y1 = y;
    return y;
}
