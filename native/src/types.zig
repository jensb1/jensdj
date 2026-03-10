// types.zig — All struct types, constants, and opaque miniaudio wrappers.
// Replaces djengine_internal.h, filter.h, midi.h

// --- Constants ---

pub const MAX_DEVICES = 64;
pub const RB_BLOCK_SIZE = 1024;
pub const MAX_CHANNELS = 2;
pub const IO_MAP_SIZE = 64;
pub const BEAT_SAMPLERATE = 44100;
pub const MAX_TRANSIENTS = 500;

// Parameter automation indices
pub const DJ_PARAM_FILTER = 0;
pub const DJ_PARAM_VOLUME = 1;
pub const DJ_PARAM_EQ_LO = 2;
pub const DJ_PARAM_EQ_MID = 3;
pub const DJ_PARAM_EQ_HI = 4;
pub const DJ_PARAM_COUNT = 5;

// Automation interpolation modes
pub const DJ_INTERP_LINEAR = 0;
pub const DJ_INTERP_EASE_IN = 1;
pub const DJ_INTERP_EASE_OUT = 2;

// miniaudio constants
pub const MA_SUCCESS: c_int = 0;
pub const MA_ERROR: c_int = -1;
pub const MA_AT_END: c_int = -17;
pub const MA_FORMAT_F32: c_int = 5;
pub const MA_STANDARD_CHANNEL_MAP_DEFAULT: c_int = 0;
pub const MA_SOUND_FLAG_NO_SPATIALIZATION: u32 = 16384;

// RubberBand option flags
pub const RB_OPTION_PROCESS_REALTIME: c_int = 1;
pub const RB_OPTION_ENGINE_FINER: c_int = 536870912;
pub const RB_OPTION_THREADING_NEVER: c_int = 65536;

// MIDI constants
pub const MIDI_RING_SIZE = 512;
pub const MIDI_NAME_BUF = 256;

// --- Opaque miniaudio types (verified sizes on aarch64 macOS) ---

pub const MaDataSourceBase = extern struct { _: [9]u64 }; // 72 bytes, align 8
pub const MaContext = extern struct { _: [86]u64 }; // 688 bytes, align 8
pub const MaEngine = extern struct { _: [170]u64 }; // 1360 bytes, align 8
pub const MaSound = extern struct { _: [128]u64 }; // 1024 bytes, align 8
pub const MaDeviceInfo = extern struct { _: [193]u64 }; // 1544 bytes, align 8
pub const MaDecoder = extern struct { _: [69]u64 }; // 552 bytes, align 8
pub const MaDecoderConfig = extern struct { _: [18]u64 }; // 144 bytes, align 8
pub const MaEngineConfig = extern struct { _: [33]u64 }; // 264 bytes, align 8
pub const MaDataSourceConfig = extern struct { _: [1]u64 }; // 8 bytes, align 8

// --- miniaudio data source vtable ---

pub const VtableReadFn = *const fn (?*anyopaque, ?*anyopaque, u64, ?*u64) callconv(.c) c_int;
pub const VtableSeekFn = *const fn (?*anyopaque, u64) callconv(.c) c_int;
pub const VtableGetDataFormatFn = *const fn (?*anyopaque, ?*c_int, ?*u32, ?*u32, ?*u8, usize) callconv(.c) c_int;
pub const VtableGetCursorFn = *const fn (?*anyopaque, ?*u64) callconv(.c) c_int;
pub const VtableGetLengthFn = *const fn (?*anyopaque, ?*u64) callconv(.c) c_int;
pub const VtableSetLoopingFn = *const fn (?*anyopaque, u32) callconv(.c) c_int;

pub const MaDataSourceVtable = extern struct {
    onRead: ?VtableReadFn = null,
    onSeek: ?VtableSeekFn = null,
    onGetDataFormat: ?VtableGetDataFormatFn = null,
    onGetCursor: ?VtableGetCursorFn = null,
    onGetLength: ?VtableGetLengthFn = null,
    onSetLooping: ?VtableSetLoopingFn = null,
    flags: u32 = 0,
};

// --- Filter types (2nd order Butterworth) ---

pub const LPFilter = extern struct {
    x1: f32 = 0,
    x2: f32 = 0,
    y1: f32 = 0,
    y2: f32 = 0,
    b0: f32 = 0,
    b1: f32 = 0,
    b2: f32 = 0,
    a1: f32 = 0,
    a2: f32 = 0,
};

pub const HPFilter = extern struct {
    x1: f32 = 0,
    x2: f32 = 0,
    y1: f32 = 0,
    y2: f32 = 0,
    b0: f32 = 0,
    b1: f32 = 0,
    b2: f32 = 0,
    a1: f32 = 0,
    a2: f32 = 0,
};

// --- IO mapping ---

pub const IOMapEntry = extern struct {
    output_frame: u64 = 0,
    input_frame: u64 = 0,
};

// --- Parameter automation ---

pub const DJAutomation = extern struct {
    active: c_int = 0,
    start_value: f32 = 0,
    end_value: f32 = 0,
    _pad0: u32 = 0, // alignment padding before u64
    start_frame: u64 = 0,
    duration_frames: u64 = 0,
    interp: c_int = 0,
    current_value: f32 = 0,
};

// --- Core engine types ---

pub const DJGlobal = extern struct {
    context: MaContext = std.mem.zeroes(MaContext),
    playback_devices: [MAX_DEVICES]MaDeviceInfo = std.mem.zeroes([MAX_DEVICES]MaDeviceInfo),
    playback_device_count: u32 = 0,
    initialized: c_int = 0,
    global_phase_origin: u64 = 0,
    global_bar_frames: u64 = 0,
    global_bar_duration: f32 = 0,
    _pad0: u32 = 0, // alignment padding before pointer
    global_engine: ?*MaEngine = null,
    device_period_frames: u64 = 0,
};

pub const DJEngine = extern struct {
    engine: MaEngine = std.mem.zeroes(MaEngine),
    device_index: c_int = 0,
};

pub const DJStretchedSource = extern struct {
    // MUST be first field — miniaudio casts pointer for vtable dispatch
    base: MaDataSourceBase = std.mem.zeroes(MaDataSourceBase),
    pcm_data: ?[*]f32 = null,
    total_frames: u64 = 0,
    read_cursor: u64 = 0,
    channels: u32 = 0,
    sample_rate: u32 = 0,

    rb: ?*anyopaque = null, // RubberBandState
    _pad_rb: u32 = 0,
    time_ratio: f64 = 1.0,
    pitch_scale: f64 = 1.0,

    deinterleaved_in: [MAX_CHANNELS]?[*]f32 = .{null} ** MAX_CHANNELS,
    deinterleaved_out: [MAX_CHANNELS]?[*]f32 = .{null} ** MAX_CHANNELS,

    // Per-channel 3-band EQ filters (cascaded 2nd-order = 4th-order Butterworth)
    eq_lo_lp: [MAX_CHANNELS][2]LPFilter = std.mem.zeroes([MAX_CHANNELS][2]LPFilter),
    eq_hi_hp: [MAX_CHANNELS][2]HPFilter = std.mem.zeroes([MAX_CHANNELS][2]HPFilter),
    eq_lo_gain: ?*f32 = null,
    eq_mid_gain: ?*f32 = null,
    eq_hi_gain: ?*f32 = null,

    // RMS metering
    rms_sum: f64 = 0,
    rms_count: u64 = 0,
    current_rms: f32 = 0,

    // Loop points (input frames)
    _pad1: u32 = 0,
    loop_start_frame: u64 = 0,
    loop_end_frame: u64 = 0,
    loop_active: c_int = 0,
    _pad2: u32 = 0,
    loop_output_start: u64 = 0,
    loop_output_duration: u64 = 0,
    loop_output_tracking: c_int = 0,
    _pad3: u32 = 0,
    loop_output_wrap_point: u64 = 0,
    loop_measured: c_int = 0,
    _pad4: u32 = 0,
    loop_measured_duration: u64 = 0,

    // DJ filter
    djf_lp: [MAX_CHANNELS][2]LPFilter = std.mem.zeroes([MAX_CHANNELS][2]LPFilter),
    djf_hp: [MAX_CHANNELS][2]HPFilter = std.mem.zeroes([MAX_CHANNELS][2]HPFilter),
    djf_value: ?*f32 = null,
    djf_initialized: c_int = 0,
    djf_last_value: f32 = 0.5,

    owner: ?*anyopaque = null, // *DJSound
    output_frame_count: u64 = 0,

    // IO mapping ring buffer
    io_map: [IO_MAP_SIZE]IOMapEntry = std.mem.zeroes([IO_MAP_SIZE]IOMapEntry),
    io_map_write: c_int = 0,
    io_map_count: c_int = 0,

    // RubberBand start delay
    rb_start_delay_remaining: u64 = 0,

    // Phase tracking against global clock
    phase_active: c_int = 0,
    phase_diff: f32 = 0, // accessed atomically
    phase_diff_gen: u64 = 0, // accessed atomically

    // Sync-pending
    sync_pending: c_int = 0,
    sync_target_beat: f32 = 0,

    // Phase diagnostic counter
    phase_diag_remaining: c_int = 0,
};

pub const DJSound = extern struct {
    sound: MaSound = std.mem.zeroes(MaSound),
    engine: ?*DJEngine = null,
    source: ?*DJStretchedSource = null,
    volume: f32 = 1.0,
    eq_lo: f32 = 1.0,
    eq_mid: f32 = 1.0,
    eq_hi: f32 = 1.0,
    current_level: f32 = 0,
    original_bpm: f32 = 0,
    filter_value: f32 = 0.5,
    beat_ref: f32 = 0,
    scheduled: c_int = 0,
    automations: [DJ_PARAM_COUNT]DJAutomation = std.mem.zeroes([DJ_PARAM_COUNT]DJAutomation),
    beat_grid: ?*anyopaque = null, // *BeatGrid (managed by sync_engine.zig)
};

// --- MIDI ---

pub const DjMidiMessage = extern struct {
    status: u8 = 0, // 0xB0=CC, 0x90=note on, 0x80=note off
    data1: u8 = 0, // CC number or note number
    data2: u8 = 0, // value 0-127
    channel: u8 = 0, // MIDI channel 0-15
};

const std = @import("std");
