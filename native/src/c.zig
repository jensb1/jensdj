// c.zig — All extern fn declarations for external C libraries.
// No @cImport — every symbol declared explicitly.

const types = @import("types.zig");

// =========================================================================
// miniaudio (audio I/O, decoding)
// =========================================================================

// Context
pub extern fn ma_context_init(backends: ?*const anyopaque, backend_count: u32, config: ?*const anyopaque, context: *types.MaContext) c_int;
pub extern fn ma_context_uninit(context: *types.MaContext) void;
pub extern fn ma_context_get_devices(context: *types.MaContext, ppPlaybackDeviceInfos: *?[*]types.MaDeviceInfo, pPlaybackDeviceCount: *u32, ppCaptureDeviceInfos: ?*?[*]types.MaDeviceInfo, pCaptureDeviceCount: ?*u32) c_int;

// Engine
pub extern fn ma_engine_init(config: *const anyopaque, engine: *types.MaEngine) c_int;
pub extern fn ma_engine_uninit(engine: *types.MaEngine) void;
pub extern fn ma_engine_get_sample_rate(engine: *types.MaEngine) u32;
pub extern fn ma_engine_get_time_in_pcm_frames(engine: *types.MaEngine) u64;
pub extern fn ma_engine_get_device(engine: *types.MaEngine) ?*anyopaque;

// Sound
pub extern fn ma_sound_init_from_data_source(engine: *types.MaEngine, data_source: ?*anyopaque, flags: u32, group: ?*anyopaque, sound: *types.MaSound) c_int;
pub extern fn ma_sound_uninit(sound: *types.MaSound) void;
pub extern fn ma_sound_start(sound: *types.MaSound) c_int;
pub extern fn ma_sound_stop(sound: *types.MaSound) c_int;
pub extern fn ma_sound_is_playing(sound: *types.MaSound) u32;
pub extern fn ma_sound_set_volume(sound: *types.MaSound, volume: f32) void;
pub extern fn ma_sound_set_start_time_in_pcm_frames(sound: *types.MaSound, frame: u64) void;
pub extern fn ma_sound_seek_to_pcm_frame(sound: *types.MaSound, frame: u64) c_int;
pub extern fn ma_sound_get_length_in_seconds(sound: *types.MaSound, length: *f32) c_int;

// Data source
pub extern fn ma_data_source_init(config: *const anyopaque, data_source: *types.MaDataSourceBase) c_int;

// Decoder
pub extern fn ma_decoder_init_file(filepath: [*:0]const u8, config: *const anyopaque, decoder: *types.MaDecoder) c_int;
pub extern fn ma_decoder_uninit(decoder: *types.MaDecoder) c_int;
pub extern fn ma_decoder_get_length_in_pcm_frames(decoder: *types.MaDecoder, length: *u64) c_int;
pub extern fn ma_decoder_read_pcm_frames(decoder: *types.MaDecoder, frames_out: [*]f32, frame_count: u64, frames_read: *u64) c_int;

// Channel map
pub extern fn ma_channel_map_init_standard(layout: c_int, channel_map: [*]u8, channel_map_cap: usize, channels: u32) void;

// =========================================================================
// RubberBand (time-stretch, pitch)
// =========================================================================

pub extern fn rubberband_new(sample_rate: c_uint, channels: c_uint, options: c_int, initial_time_ratio: f64, initial_pitch_scale: f64) ?*anyopaque;
pub extern fn rubberband_delete(state: ?*anyopaque) void;
pub extern fn rubberband_set_time_ratio(state: ?*anyopaque, ratio: f64) void;
pub extern fn rubberband_set_pitch_scale(state: ?*anyopaque, scale: f64) void;
pub extern fn rubberband_set_max_process_size(state: ?*anyopaque, samples: c_uint) void;
pub extern fn rubberband_get_preferred_start_pad(state: ?*anyopaque) c_uint;
pub extern fn rubberband_get_start_delay(state: ?*anyopaque) c_uint;
pub extern fn rubberband_get_latency(state: ?*anyopaque) c_uint;
pub extern fn rubberband_process(state: ?*anyopaque, input: [*]const ?[*]const f32, samples: c_uint, final: c_int) void;
pub extern fn rubberband_available(state: ?*anyopaque) c_int;
pub extern fn rubberband_retrieve(state: ?*anyopaque, output: [*]?[*]f32, samples: c_uint) c_uint;
pub extern fn rubberband_reset(state: ?*anyopaque) void;

// =========================================================================
// aubio (BPM/beat detection)
// =========================================================================

pub const FvecT = anyopaque;
pub extern fn new_aubio_tempo(method: [*:0]const u8, buf_size: c_uint, hop_size: c_uint, samplerate: c_uint) ?*anyopaque;
pub extern fn del_aubio_tempo(tempo: ?*anyopaque) void;
pub extern fn aubio_tempo_do(tempo: ?*anyopaque, input: ?*FvecT, output: ?*FvecT) void;
pub extern fn aubio_tempo_get_bpm(tempo: ?*anyopaque) f32;
pub extern fn new_fvec(length: c_uint) ?*FvecT;
pub extern fn del_fvec(vec: ?*FvecT) void;

/// Access fvec_t.data — aubio stores data as float* at a known offset.
/// fvec_t is: { uint_t length; smpl_t* data; }
pub fn fvec_data(vec: *FvecT) [*]f32 {
    // fvec_t layout: length (4 bytes) + padding (4 bytes) + data pointer (8 bytes)
    const ptr: [*]u8 = @ptrCast(vec);
    return @as(*align(1) [*]f32, @ptrCast(ptr + 8)).*;
}

// =========================================================================
// CoreMIDI / CoreFoundation (macOS)
// =========================================================================

pub extern fn MIDIClientCreate(name: ?*const anyopaque, notify_proc: ?*const anyopaque, notify_ref_con: ?*anyopaque, out_client: *u32) i32;
pub extern fn MIDIClientDispose(client: u32) i32;
pub extern fn MIDIInputPortCreate(client: u32, name: ?*const anyopaque, read_proc: ?*const anyopaque, ref_con: ?*anyopaque, out_port: *u32) i32;
pub extern fn MIDIOutputPortCreate(client: u32, name: ?*const anyopaque, out_port: *u32) i32;
pub extern fn MIDIPortDispose(port: u32) i32;
pub extern fn MIDIGetNumberOfSources() u64;
pub extern fn MIDIGetNumberOfDestinations() u64;
pub extern fn MIDIGetSource(index: u64) u32;
pub extern fn MIDIGetDestination(index: u64) u32;
pub extern fn MIDIObjectGetStringProperty(obj: u32, property_id: ?*const anyopaque, str: *?*const anyopaque) i32;
pub extern fn MIDIPortConnectSource(port: u32, source: u32, conn_ref_con: ?*anyopaque) i32;
pub extern fn MIDIPortDisconnectSource(port: u32, source: u32) i32;
pub extern fn MIDISend(port: u32, dest: u32, pkt_list: ?*const anyopaque) i32;

pub extern fn CFStringGetCString(str: ?*const anyopaque, buffer: [*]u8, buffer_size: i64, encoding: u32) u8;
pub extern fn CFRelease(cf: ?*const anyopaque) void;
pub extern fn __CFStringMakeConstantString(c_str: [*:0]const u8) ?*const anyopaque;

pub const kCFStringEncodingUTF8: u32 = 0x08000100;

// CoreMIDI property keys (resolved at link time)
pub extern var kMIDIPropertyDisplayName: ?*const anyopaque;
pub extern var kMIDIPropertyName: ?*const anyopaque;

// =========================================================================
// c_api.c helpers (wrappers for miniaudio static inline functions)
// =========================================================================

pub extern fn dj_c_decoder_config_init(out: *types.MaDecoderConfig, format: c_int, channels: c_uint, sample_rate: c_uint) void;
pub extern fn dj_c_engine_config_init(out: *types.MaEngineConfig) void;
pub extern fn dj_c_engine_config_set_device(config: *types.MaEngineConfig, device_id: ?*const anyopaque) void;
pub extern fn dj_c_data_source_config_init(out: *types.MaDataSourceConfig, vtable: ?*const types.MaDataSourceVtable) void;
pub extern fn dj_c_get_device_period(engine: *types.MaEngine) u64;
pub extern fn dj_c_device_info_name(info: *const types.MaDeviceInfo) [*:0]const u8;
pub extern fn dj_c_device_info_channels(info: *const types.MaDeviceInfo) c_int;
pub extern fn dj_c_device_info_id(info: *const types.MaDeviceInfo) ?*const anyopaque;

// =========================================================================
// C standard library
// =========================================================================

pub extern fn fprintf(stream: *anyopaque, fmt: [*:0]const u8, ...) c_int;
pub extern var __stderrp: *anyopaque; // stderr on macOS
