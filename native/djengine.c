/*
 * djengine.c — Native audio engine wrapping miniaudio + aubio + rubberband
 *
 * Provides: multi-device playback, time-stretching, waveform peaks, BPM/beat detection
 * Compiled to libdjengine.dylib, called from Bun via FFI.
 */

#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"
#include "djengine.h"

#include <aubio/aubio.h>
#include <rubberband/rubberband-c.h>
#include "midi.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdatomic.h>

#include <CoreMIDI/CoreMIDI.h>
#include <CoreFoundation/CoreFoundation.h>

// --- Internal types ---

#define MAX_DEVICES 64
#define RB_BLOCK_SIZE 1024
#define MAX_CHANNELS 2

// Low-pass filter (2nd order Butterworth)
typedef struct {
    float x1, x2, y1, y2;
    float b0, b1, b2, a1, a2;
} LPFilter;

static void lp_init(LPFilter* f, float cutoff_hz, float samplerate);
static float lp_process(LPFilter* f, float x);

// High-pass filter (2nd order Butterworth)
typedef struct {
    float x1, x2, y1, y2;
    float b0, b1, b2, a1, a2;
} HPFilter;

static void hp_init(HPFilter* f, float cutoff_hz, float samplerate);
static float hp_process(HPFilter* f, float x);

typedef struct {
    ma_context context;
    ma_device_info playback_devices[MAX_DEVICES];
    ma_uint32 playback_device_count;
    int initialized;
} DJGlobal;

typedef struct {
    ma_engine engine;
    int device_index;
} DJEngine;

// Custom data source that wraps decoded PCM + Rubber Band stretcher
typedef struct DJStretchedSource_tag {
    ma_data_source_base base;
    float* pcm_data;          // Full decoded PCM, interleaved
    ma_uint64 total_frames;
    ma_uint64 read_cursor;    // Current position in original PCM
    ma_uint32 channels;
    ma_uint32 sample_rate;

    // Rubber Band
    RubberBandState rb;
    double time_ratio;        // 1.0 = normal, <1.0 = faster, >1.0 = slower
    double pitch_scale;       // 1.0 = normal (key lock preserves pitch)

    // Deinterleaved temp buffers
    float* deinterleaved_in[MAX_CHANNELS];
    float* deinterleaved_out[MAX_CHANNELS];

    // Per-channel 3-band EQ filters (cascaded 2nd-order = 4th-order Butterworth)
    LPFilter eq_lo_lp[MAX_CHANNELS][2];   // LP at 500Hz
    HPFilter eq_hi_hp[MAX_CHANNELS][2];   // HP at 2500Hz
    float* eq_lo_gain;   // pointer to DJSound.eq_lo
    float* eq_mid_gain;  // pointer to DJSound.eq_mid
    float* eq_hi_gain;   // pointer to DJSound.eq_hi

    // Real RMS metering
    double rms_sum;
    ma_uint64 rms_count;
    float current_rms;

    // Loop points (input frames)
    ma_uint64 loop_start_frame;
    ma_uint64 loop_end_frame;
    int loop_active;
    // Output-frame-based loop tracking for sample-accurate wrapping
    ma_uint64 loop_output_start;    // output_frame_count when loop region was entered
    ma_uint64 loop_output_duration; // exact output frames per loop iteration
    int loop_output_tracking;       // 1 = we've set up output tracking

    // DJ filter (single-knob LP/HP sweep)
    LPFilter djf_lp[MAX_CHANNELS][2];  // cascaded LP for DJ filter
    HPFilter djf_hp[MAX_CHANNELS][2];  // cascaded HP for DJ filter
    float* djf_value;    // pointer to DJSound.filter_value
    int djf_initialized; // whether filter coefficients are current
    float djf_last_value; // last filter value used for coefficient computation

    void* owner;  // back-pointer to DJSound (set after creation)
    ma_uint64 output_frame_count;  // monotonic output frame counter for automation timing

    // Phase tracking: output_frame_count at which bar-phase was 0
    ma_uint64 phase_origin;       // set at sync start
    ma_uint64 phase_bar_frames;   // bar duration in output frames (0 = not tracking)
    struct DJStretchedSource_tag* phase_partner;  // other track to compute diff with
    _Atomic float phase_diff;     // updated in audio callback after both tracks processed
    ma_uint64 phase_partner_prev_count; // last read partner output_frame_count; used to detect ordering
} DJStretchedSource;

// Parameter automation slot
#define DJ_PARAM_FILTER 0
#define DJ_PARAM_VOLUME 1
#define DJ_PARAM_EQ_LO  2
#define DJ_PARAM_EQ_MID 3
#define DJ_PARAM_EQ_HI  4
#define DJ_PARAM_COUNT  5

#define DJ_INTERP_LINEAR  0
#define DJ_INTERP_EASE_IN 1
#define DJ_INTERP_EASE_OUT 2

typedef struct {
    int active;
    float start_value;
    float end_value;
    ma_uint64 start_frame;
    ma_uint64 duration_frames;
    int interp;           // DJ_INTERP_*
    float current_value;  // last computed value (for JS readback)
} DJAutomation;

typedef struct {
    ma_sound sound;
    DJEngine* engine;
    DJStretchedSource* source;
    float volume;
    float eq_lo;
    float eq_mid;
    float eq_hi;
    float current_level;
    float original_bpm;
    float filter_value;  // 0.0 = full LP, 0.5 = bypass, 1.0 = full HP
    int scheduled; // 1 = sync_start pending, waiting for engine clock
    DJAutomation automations[DJ_PARAM_COUNT];
} DJSound;

// --- Globals ---

static DJGlobal g_dj = {0};

// --- Stretched data source vtable ---

static ma_result stretched_read(ma_data_source* pDataSource, void* pFramesOut, ma_uint64 frameCount, ma_uint64* pFramesRead) {
    DJStretchedSource* src = (DJStretchedSource*)pDataSource;
    float* out = (float*)pFramesOut;
    ma_uint64 frames_written = 0;

    while (frames_written < frameCount) {
        // Check if Rubber Band has output available
        int available = rubberband_available(src->rb);
        if (available > 0) {
            unsigned int to_retrieve = (unsigned int)(frameCount - frames_written);
            if (to_retrieve > (unsigned int)available) to_retrieve = (unsigned int)available;

            // Retrieve into deinterleaved buffers
            unsigned int retrieved = rubberband_retrieve(src->rb, src->deinterleaved_out, to_retrieve);

            // DJ filter: check if active and update coefficients if value changed
            float djf_val = src->djf_value ? *src->djf_value : 0.5f;
            int djf_active = (djf_val < 0.49f || djf_val > 0.51f);
            if (djf_active && (!src->djf_initialized || fabsf(djf_val - src->djf_last_value) > 0.001f)) {
                float sr = (float)src->sample_rate;
                if (djf_val < 0.5f) {
                    // LP mode: cutoff sweeps 100Hz (val=0) to 20kHz (val=0.5)
                    float t = djf_val / 0.5f; // 0..1
                    float cutoff = 100.0f * powf(200.0f, t); // 100 to 20000
                    for (unsigned int ch = 0; ch < src->channels; ch++) {
                        lp_init(&src->djf_lp[ch][0], cutoff, sr);
                        lp_init(&src->djf_lp[ch][1], cutoff, sr);
                    }
                } else {
                    // HP mode: cutoff sweeps 20Hz (val=0.5) to 5kHz (val=1.0)
                    float t = (djf_val - 0.5f) / 0.5f; // 0..1
                    float cutoff = 20.0f * powf(250.0f, t); // 20 to 5000
                    for (unsigned int ch = 0; ch < src->channels; ch++) {
                        hp_init(&src->djf_hp[ch][0], cutoff, sr);
                        hp_init(&src->djf_hp[ch][1], cutoff, sr);
                    }
                }
                src->djf_last_value = djf_val;
                src->djf_initialized = 1;
            }

            // Advance automations once per chunk (not per-sample)
            DJSound* auto_snd = (DJSound*)src->owner;
            if (auto_snd) {
                ma_uint64 chunk_mid = src->output_frame_count + retrieved / 2;
                for (int p = 0; p < DJ_PARAM_COUNT; p++) {
                    DJAutomation* a = &auto_snd->automations[p];
                    if (!a->active) continue;
                    float t;
                    if (a->duration_frames == 0) {
                        t = 1.0f;
                    } else if (chunk_mid >= a->start_frame + a->duration_frames) {
                        t = 1.0f;
                    } else if (chunk_mid <= a->start_frame) {
                        t = 0.0f;
                    } else {
                        t = (float)(chunk_mid - a->start_frame) / (float)a->duration_frames;
                    }
                    switch (a->interp) {
                        case DJ_INTERP_EASE_IN:  t = t * t; break;
                        case DJ_INTERP_EASE_OUT: t = 1.0f - (1.0f - t) * (1.0f - t); break;
                        default: break;
                    }
                    float val = a->start_value + (a->end_value - a->start_value) * t;
                    a->current_value = val;
                    if (p == DJ_PARAM_FILTER) {
                        auto_snd->filter_value = val;
                    } else if (p == DJ_PARAM_VOLUME) {
                        auto_snd->volume = val;
                        ma_sound_set_volume(&auto_snd->sound, val);
                    } else if (p == DJ_PARAM_EQ_LO) {
                        auto_snd->eq_lo = val;
                    } else if (p == DJ_PARAM_EQ_MID) {
                        auto_snd->eq_mid = val;
                    } else if (p == DJ_PARAM_EQ_HI) {
                        auto_snd->eq_hi = val;
                    }
                    // Deactivate when done
                    if (a->duration_frames == 0 || chunk_mid >= a->start_frame + a->duration_frames) {
                        a->active = 0;
                    }
                }
                // Re-read filter value after automation may have changed it
                djf_val = src->djf_value ? *src->djf_value : 0.5f;
                djf_active = (djf_val < 0.49f || djf_val > 0.51f);
                if (djf_active && (!src->djf_initialized || fabsf(djf_val - src->djf_last_value) > 0.001f)) {
                    float sr = (float)src->sample_rate;
                    if (djf_val < 0.5f) {
                        float ft = djf_val / 0.5f;
                        float cutoff = 100.0f * powf(200.0f, ft);
                        for (unsigned int ch = 0; ch < src->channels; ch++) {
                            lp_init(&src->djf_lp[ch][0], cutoff, sr);
                            lp_init(&src->djf_lp[ch][1], cutoff, sr);
                        }
                    } else {
                        float ft = (djf_val - 0.5f) / 0.5f;
                        float cutoff = 20.0f * powf(250.0f, ft);
                        for (unsigned int ch = 0; ch < src->channels; ch++) {
                            hp_init(&src->djf_hp[ch][0], cutoff, sr);
                            hp_init(&src->djf_hp[ch][1], cutoff, sr);
                        }
                    }
                    src->djf_last_value = djf_val;
                    src->djf_initialized = 1;
                }
            }

            // Read EQ gains after automation (automation may have updated them)
            float lo_g = src->eq_lo_gain ? *src->eq_lo_gain : 1.0f;
            float mi_g = src->eq_mid_gain ? *src->eq_mid_gain : 1.0f;
            float hi_g = src->eq_hi_gain ? *src->eq_hi_gain : 1.0f;

            for (unsigned int i = 0; i < retrieved; i++) {
                for (unsigned int ch = 0; ch < src->channels; ch++) {
                    float sample = src->deinterleaved_out[ch][i];
                    // Split into 3 bands
                    float lo = lp_process(&src->eq_lo_lp[ch][1],
                               lp_process(&src->eq_lo_lp[ch][0], sample));
                    float hi = hp_process(&src->eq_hi_hp[ch][1],
                               hp_process(&src->eq_hi_hp[ch][0], sample));
                    float mid = sample - lo - hi;
                    // Apply gains and sum
                    float result = lo * lo_g + mid * mi_g + hi * hi_g;
                    // Apply DJ filter after EQ
                    if (djf_active) {
                        if (djf_val < 0.5f) {
                            result = lp_process(&src->djf_lp[ch][1],
                                     lp_process(&src->djf_lp[ch][0], result));
                        } else {
                            result = hp_process(&src->djf_hp[ch][1],
                                     hp_process(&src->djf_hp[ch][0], result));
                        }
                    }
                    out[(frames_written + i) * src->channels + ch] = result;
                    // RMS accumulation
                    src->rms_sum += (double)(result * result);
                    src->rms_count++;
                }
            }
            src->output_frame_count += retrieved;
            frames_written += retrieved;

            // Compute sync diff: only write when we are the SECOND track to run this callback.
            // The second track has fresh output_frame_count for both itself and its partner,
            // so the diff is accurate. The first track would read a stale partner count.
            // We detect ordering by comparing partner->output_frame_count to the last value
            // we saw: if it advanced, partner already ran this callback → we are second.
            if (src->phase_partner && src->phase_bar_frames > 0) {
                DJStretchedSource* partner = src->phase_partner;
                ma_uint64 partner_count = partner->output_frame_count;
                if (partner_count > src->phase_partner_prev_count) {
                    // Partner already ran this callback — our diff is authoritative
                    ma_uint64 bar = src->phase_bar_frames;
                    ma_uint64 my_phase = (src->output_frame_count - src->phase_origin) % bar;
                    ma_uint64 partner_phase = (partner_count - partner->phase_origin) % bar;
                    ma_int64 d = (ma_int64)my_phase - (ma_int64)partner_phase;
                    if (d > (ma_int64)(bar / 2)) d -= (ma_int64)bar;
                    if (d < -(ma_int64)(bar / 2)) d += (ma_int64)bar;
                    atomic_store_explicit(&src->phase_diff, (float)d / (float)src->sample_rate, memory_order_relaxed);
                }
                // Always update our stored partner count for the next callback
                src->phase_partner_prev_count = partner_count;
            }

            continue;
        }

        // Loop: just wrap input cursor when it passes the end.
        // The input-clamping below handles feeding loop-start PCM seamlessly.
        if (src->loop_active && src->read_cursor >= src->loop_end_frame &&
            src->loop_end_frame > src->loop_start_frame) {
            src->read_cursor = src->loop_start_frame;
        }

        // Need to feed more input to Rubber Band
        if (src->read_cursor >= src->total_frames) {
            // End of audio
            break;
        }

        unsigned int to_feed = RB_BLOCK_SIZE;
        if (src->read_cursor + to_feed > src->total_frames) {
            to_feed = (unsigned int)(src->total_frames - src->read_cursor);
        }

        // If looping, don't feed past loop end (input-frame clamping)
        if (src->loop_active && src->loop_end_frame > src->loop_start_frame) {
            if (src->read_cursor + to_feed > src->loop_end_frame) {
                to_feed = (unsigned int)(src->loop_end_frame - src->read_cursor);
                if (to_feed == 0) {
                    // Input exhausted but output tracking hasn't triggered wrap yet.
                    // Feed from loop start to keep Rubber Band's buffer full.
                    src->read_cursor = src->loop_start_frame;
                    continue;
                }
            }
        }

        // Deinterleave input
        for (unsigned int i = 0; i < to_feed; i++) {
            for (unsigned int ch = 0; ch < src->channels; ch++) {
                src->deinterleaved_in[ch][i] = src->pcm_data[(src->read_cursor + i) * src->channels + ch];
            }
        }

        int is_final = (src->read_cursor + to_feed >= src->total_frames) ? 1 : 0;
        if (src->loop_active) is_final = 0; // never signal final when looping
        rubberband_process(src->rb, (const float* const*)src->deinterleaved_in, to_feed, is_final);
        src->read_cursor += to_feed;
    }

    if (pFramesRead) *pFramesRead = frames_written;
    return (frames_written > 0) ? MA_SUCCESS : MA_AT_END;
}

static ma_result stretched_seek(ma_data_source* pDataSource, ma_uint64 frameIndex) {
    DJStretchedSource* src = (DJStretchedSource*)pDataSource;
    // Adjust for time ratio: the user seeks in "output" time,
    // but we need to seek in "input" time
    ma_uint64 input_frame = (ma_uint64)((double)frameIndex / src->time_ratio);
    if (input_frame > src->total_frames) input_frame = src->total_frames;
    src->read_cursor = input_frame;
    rubberband_reset(src->rb);
    return MA_SUCCESS;
}

static ma_result stretched_get_data_format(ma_data_source* pDataSource, ma_format* pFormat, ma_uint32* pChannels, ma_uint32* pSampleRate, ma_channel* pChannelMap, size_t channelMapCap) {
    DJStretchedSource* src = (DJStretchedSource*)pDataSource;
    if (pFormat) *pFormat = ma_format_f32;
    if (pChannels) *pChannels = src->channels;
    if (pSampleRate) *pSampleRate = src->sample_rate;
    if (pChannelMap) {
        ma_channel_map_init_standard(ma_standard_channel_map_default, pChannelMap, channelMapCap, src->channels);
    }
    return MA_SUCCESS;
}

static ma_result stretched_get_cursor(ma_data_source* pDataSource, ma_uint64* pCursor) {
    DJStretchedSource* src = (DJStretchedSource*)pDataSource;
    // Compensate for all buffering between read_cursor and actual audio output:
    // 1. Rubber Band processing latency (input frames consumed but not yet output)
    // 2. Rubber Band buffered output (produced but not yet retrieved by us)
    unsigned int rb_latency = rubberband_get_latency(src->rb);
    int rb_available = rubberband_available(src->rb);
    if (rb_available < 0) rb_available = 0;
    // rb_available is in output frames; convert back to input frames
    ma_uint64 rb_avail_input = (ma_uint64)((double)rb_available / src->time_ratio);
    ma_uint64 total_offset = (ma_uint64)rb_latency + rb_avail_input;
    ma_uint64 adjusted = src->read_cursor > total_offset ? src->read_cursor - total_offset : 0;
    if (pCursor) *pCursor = (ma_uint64)((double)adjusted * src->time_ratio);
    return MA_SUCCESS;
}

static ma_result stretched_get_length(ma_data_source* pDataSource, ma_uint64* pLength) {
    DJStretchedSource* src = (DJStretchedSource*)pDataSource;
    // Stretched length = original length * time_ratio
    if (pLength) *pLength = (ma_uint64)((double)src->total_frames * src->time_ratio);
    return MA_SUCCESS;
}

static ma_data_source_vtable g_stretched_vtable = {
    stretched_read,
    stretched_seek,
    stretched_get_data_format,
    stretched_get_cursor,
    stretched_get_length
};

static DJStretchedSource* create_stretched_source(const char* filepath, ma_uint32 target_channels, ma_uint32 target_samplerate) {
    // Decode entire file
    ma_decoder decoder;
    ma_decoder_config dconfig = ma_decoder_config_init(ma_format_f32, target_channels, target_samplerate);
    if (ma_decoder_init_file(filepath, &dconfig, &decoder) != MA_SUCCESS) {
        return NULL;
    }

    ma_uint64 total_frames = 0;
    ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);
    if (total_frames == 0) {
        ma_decoder_uninit(&decoder);
        return NULL;
    }

    float* pcm = (float*)malloc(total_frames * target_channels * sizeof(float));
    if (!pcm) {
        ma_decoder_uninit(&decoder);
        return NULL;
    }

    ma_uint64 frames_read = 0;
    ma_decoder_read_pcm_frames(&decoder, pcm, total_frames, &frames_read);
    ma_decoder_uninit(&decoder);

    if (frames_read == 0) {
        free(pcm);
        return NULL;
    }

    DJStretchedSource* src = (DJStretchedSource*)calloc(1, sizeof(DJStretchedSource));
    if (!src) {
        free(pcm);
        return NULL;
    }

    src->pcm_data = pcm;
    src->total_frames = frames_read;
    src->read_cursor = 0;
    src->channels = target_channels;
    src->sample_rate = target_samplerate;
    src->time_ratio = 1.0;
    src->pitch_scale = 1.0;

    // Allocate deinterleaved buffers
    for (unsigned int ch = 0; ch < target_channels; ch++) {
        src->deinterleaved_in[ch] = (float*)malloc(RB_BLOCK_SIZE * sizeof(float));
        src->deinterleaved_out[ch] = (float*)malloc(RB_BLOCK_SIZE * sizeof(float));
    }

    // Create Rubber Band stretcher in real-time mode
    RubberBandOptions opts = RubberBandOptionProcessRealTime
                           | RubberBandOptionEngineFiner
                           | RubberBandOptionThreadingNever;
    src->rb = rubberband_new(target_samplerate, target_channels, opts, 1.0, 1.0);
    rubberband_set_max_process_size(src->rb, RB_BLOCK_SIZE);

    // Initialize per-channel EQ filters (crossover: 500Hz low/mid, 2500Hz mid/high)
    for (unsigned int ch = 0; ch < target_channels; ch++) {
        lp_init(&src->eq_lo_lp[ch][0], 500.0f, (float)target_samplerate);
        lp_init(&src->eq_lo_lp[ch][1], 500.0f, (float)target_samplerate);
        hp_init(&src->eq_hi_hp[ch][0], 2500.0f, (float)target_samplerate);
        hp_init(&src->eq_hi_hp[ch][1], 2500.0f, (float)target_samplerate);
    }
    src->eq_lo_gain = NULL;
    src->eq_mid_gain = NULL;
    src->eq_hi_gain = NULL;
    src->rms_sum = 0;
    src->rms_count = 0;
    src->current_rms = 0;
    src->loop_start_frame = 0;
    src->loop_end_frame = 0;
    src->loop_active = 0;
    src->loop_output_start = 0;
    src->loop_output_duration = 0;
    src->loop_output_tracking = 0;
    src->djf_value = NULL;
    src->djf_initialized = 0;
    src->djf_last_value = 0.5f;
    src->output_frame_count = 0;
    src->phase_origin = 0;
    src->phase_bar_frames = 0;
    src->phase_partner = NULL;
    atomic_store(&src->phase_diff, 0.0f);
    src->phase_partner_prev_count = 0;

    // Init data source base
    ma_data_source_config baseConfig = ma_data_source_config_init();
    baseConfig.vtable = &g_stretched_vtable;
    ma_data_source_init(&baseConfig, &src->base);

    return src;
}

static void destroy_stretched_source(DJStretchedSource* src) {
    if (!src) return;
    if (src->rb) rubberband_delete(src->rb);
    for (unsigned int ch = 0; ch < src->channels; ch++) {
        free(src->deinterleaved_in[ch]);
        free(src->deinterleaved_out[ch]);
    }
    free(src->pcm_data);
    free(src);
}

// --- Lifecycle ---

int dj_init(void) {
    if (g_dj.initialized) return 0;

    ma_result result = ma_context_init(NULL, 0, NULL, &g_dj.context);
    if (result != MA_SUCCESS) return -1;

    g_dj.playback_device_count = MAX_DEVICES;
    result = ma_context_get_devices(
        &g_dj.context,
        &(ma_device_info*){NULL}, &g_dj.playback_device_count,
        NULL, NULL
    );

    if (result != MA_SUCCESS) {
        ma_context_uninit(&g_dj.context);
        return -2;
    }

    ma_device_info* pPlaybackDevices = NULL;
    ma_uint32 count = 0;
    ma_context_get_devices(&g_dj.context, &pPlaybackDevices, &count, NULL, NULL);

    if (count > MAX_DEVICES) count = MAX_DEVICES;
    g_dj.playback_device_count = count;
    memcpy(g_dj.playback_devices, pPlaybackDevices, count * sizeof(ma_device_info));

    g_dj.initialized = 1;
    return 0;
}

void dj_shutdown(void) {
    if (!g_dj.initialized) return;
    ma_context_uninit(&g_dj.context);
    g_dj.initialized = 0;
}

// --- Device enumeration ---

int dj_get_device_count(void) {
    return (int)g_dj.playback_device_count;
}

const char* dj_get_device_name(int index) {
    if (index < 0 || index >= (int)g_dj.playback_device_count) return "";
    return g_dj.playback_devices[index].name;
}

int dj_get_device_channels(int index) {
    if (index < 0 || index >= (int)g_dj.playback_device_count) return 0;
    if (g_dj.playback_devices[index].nativeDataFormatCount > 0) {
        return (int)g_dj.playback_devices[index].nativeDataFormats[0].channels;
    }
    return 2;
}

// --- Engine per output device ---

void* dj_create_engine(int device_index) {
    DJEngine* eng = (DJEngine*)calloc(1, sizeof(DJEngine));
    if (!eng) return NULL;

    ma_engine_config config = ma_engine_config_init();

    if (device_index >= 0 && device_index < (int)g_dj.playback_device_count) {
        config.pPlaybackDeviceID = &g_dj.playback_devices[device_index].id;
    }

    ma_result result = ma_engine_init(&config, &eng->engine);
    if (result != MA_SUCCESS) {
        free(eng);
        return NULL;
    }

    eng->device_index = device_index;
    return eng;
}

void dj_destroy_engine(void* engine) {
    if (!engine) return;
    DJEngine* eng = (DJEngine*)engine;
    ma_engine_uninit(&eng->engine);
    free(eng);
}

// --- Sound loading + playback ---

void* dj_load_sound(void* engine, const char* filepath) {
    if (!engine || !filepath) return NULL;
    DJEngine* eng = (DJEngine*)engine;

    // Create stretched source (decodes full file + creates Rubber Band)
    ma_uint32 samplerate = ma_engine_get_sample_rate(&eng->engine);
    if (samplerate == 0) samplerate = 44100;

    DJStretchedSource* source = create_stretched_source(filepath, 2, samplerate);
    if (!source) return NULL;

    DJSound* snd = (DJSound*)calloc(1, sizeof(DJSound));
    if (!snd) {
        destroy_stretched_source(source);
        return NULL;
    }

    // Create sound from our custom data source
    ma_result result = ma_sound_init_from_data_source(
        &eng->engine, &source->base,
        MA_SOUND_FLAG_NO_SPATIALIZATION,
        NULL, &snd->sound
    );

    if (result != MA_SUCCESS) {
        destroy_stretched_source(source);
        free(snd);
        return NULL;
    }

    snd->engine = eng;
    snd->source = source;
    snd->volume = 1.0f;
    snd->eq_lo = 1.0f;
    snd->eq_mid = 1.0f;
    snd->eq_hi = 1.0f;
    snd->current_level = 0.0f;
    snd->original_bpm = 0.0f;
    snd->scheduled = 0;

    // Wire EQ gain pointers so stretched_read can access them directly
    source->eq_lo_gain = &snd->eq_lo;
    source->eq_mid_gain = &snd->eq_mid;
    source->eq_hi_gain = &snd->eq_hi;

    // Wire DJ filter pointer
    snd->filter_value = 0.5f;  // bypass
    source->djf_value = &snd->filter_value;

    // Back-pointer for automation access from audio callback
    source->owner = snd;

    // Init automations
    for (int i = 0; i < DJ_PARAM_COUNT; i++) {
        snd->automations[i].active = 0;
    }

    return snd;
}

void dj_unload_sound(void* sound) {
    if (!sound) return;
    DJSound* snd = (DJSound*)sound;
    ma_sound_uninit(&snd->sound);
    destroy_stretched_source(snd->source);
    free(snd);
}

int dj_play(void* sound) {
    if (!sound) return -1;
    DJSound* snd = (DJSound*)sound;
    ma_result r = ma_sound_start(&snd->sound);
    fprintf(stderr, "[dj_play] result=%d is_playing=%d\n", r, ma_sound_is_playing(&snd->sound));
    return r == MA_SUCCESS ? 0 : -1;
}

int dj_pause(void* sound) {
    if (!sound) return -1;
    DJSound* snd = (DJSound*)sound;
    float paused_at = 0.0f;
    ma_sound_get_cursor_in_seconds(&snd->sound, &paused_at);
    snd->scheduled = 0;
    ma_sound_set_start_time_in_pcm_frames(&snd->sound, 0);
    ma_result r = ma_sound_stop(&snd->sound);
    int seek_result = 0;
    if (r == MA_SUCCESS) {
        seek_result = dj_seek(sound, paused_at);
    }
    float after_pause = 0.0f;
    ma_sound_get_cursor_in_seconds(&snd->sound, &after_pause);
    fprintf(stderr, "[dj_pause] result=%d seek=%d paused_at=%.4f after=%.4f is_playing=%d\n",
            r, seek_result, paused_at, after_pause, ma_sound_is_playing(&snd->sound));
    return r == MA_SUCCESS ? 0 : -1;
}

int dj_stop(void* sound) {
    if (!sound) return -1;
    DJSound* snd = (DJSound*)sound;
    snd->scheduled = 0;
    ma_sound_stop(&snd->sound);
    ma_sound_set_start_time_in_pcm_frames(&snd->sound, 0);
    dj_seek(sound, 0.0f);
    fprintf(stderr, "[dj_stop] is_playing=%d\n", ma_sound_is_playing(&snd->sound));
    return 0;
}

int dj_seek(void* sound, float seconds) {
    if (!sound) return -1;
    DJSound* snd = (DJSound*)sound;
    // seconds is in file-time (source time).
    // ma_sound_seek_to_pcm_frame expects output frames, which the data source
    // vtable's onSeek converts back to input frames by dividing by time_ratio.
    double time_ratio = (snd->source && snd->source->time_ratio > 0.0)
        ? snd->source->time_ratio : 1.0;
    ma_uint64 frame = (ma_uint64)(seconds * time_ratio * (double)snd->source->sample_rate);
    return ma_sound_seek_to_pcm_frame(&snd->sound, frame) == MA_SUCCESS ? 0 : -1;
}

float dj_get_position(void* sound) {
    if (!sound) return 0.0f;
    DJSound* snd = (DJSound*)sound;

    float cursor = 0.0f;
    ma_sound_get_cursor_in_seconds(&snd->sound, &cursor);
    // cursor is in output-time (stretched). Convert to file-time (source time)
    // so the frontend can work entirely in file-time coordinates.
    double time_ratio = (snd->source && snd->source->time_ratio > 0.0)
        ? snd->source->time_ratio : 1.0;
    return (float)((double)cursor / time_ratio);
}

float dj_get_duration(void* sound) {
    if (!sound) return 0.0f;
    DJSound* snd = (DJSound*)sound;

    float length = 0.0f;
    ma_sound_get_length_in_seconds(&snd->sound, &length);
    return length;
}

int dj_is_playing(void* sound) {
    if (!sound) return 0;
    DJSound* snd = (DJSound*)sound;
    if (ma_sound_is_playing(&snd->sound)) {
        snd->scheduled = 0; // clear flag once actually playing
        return 1;
    }
    return snd->scheduled ? 1 : 0;
}

void dj_set_volume(void* sound, float volume) {
    if (!sound) return;
    DJSound* snd = (DJSound*)sound;
    snd->volume = volume;
    ma_sound_set_volume(&snd->sound, volume);
    // Cancel volume automation if user manually sets volume
    snd->automations[DJ_PARAM_VOLUME].active = 0;
}

// --- Time-stretching (Rubber Band) ---

void dj_set_tempo(void* sound, float ratio) {
    if (!sound) return;
    DJSound* snd = (DJSound*)sound;
    if (!snd->source || !snd->source->rb) return;

    // ratio: 1.0 = original tempo, 1.05 = 5% faster, 0.95 = 5% slower
    // Rubber Band time_ratio is inverse: >1.0 = slower, <1.0 = faster
    // But for DJ use: ratio = targetBPM / originalBPM
    // So if we want faster playback (higher BPM), time_ratio should be < 1.0
    double rb_time_ratio = 1.0 / (double)ratio;
    snd->source->time_ratio = rb_time_ratio;
    rubberband_set_time_ratio(snd->source->rb, rb_time_ratio);
    // Pitch scale stays at 1.0 = key lock (pitch preserved)
    rubberband_set_pitch_scale(snd->source->rb, 1.0);
}

float dj_get_tempo(void* sound) {
    if (!sound) return 1.0f;
    DJSound* snd = (DJSound*)sound;
    if (!snd->source) return 1.0f;
    return (float)(1.0 / snd->source->time_ratio);
}

void dj_set_original_bpm(void* sound, float bpm) {
    if (!sound) return;
    DJSound* snd = (DJSound*)sound;
    snd->original_bpm = bpm;
}

float dj_get_original_bpm(void* sound) {
    if (!sound) return 0.0f;
    DJSound* snd = (DJSound*)sound;
    return snd->original_bpm;
}

// --- Scheduled sync playback ---

// Shared helper: start target muted, wait for RB to stabilize,
// measure actual phase error, correct, then unmute.
static int sync_measure_correct(DJSound* target, DJSound* source,
                                 float target_pos, float source_beat, float bar_duration) {
    ma_engine* engine = &source->engine->engine;
    ma_uint32 sample_rate = ma_engine_get_sample_rate(engine);

    // Step 0: Seek target to the same bar phase as source.
    // Source is at src_now. In 100ms it'll be at src_now + 0.1.
    // We need target to also be at that bar phase after 100ms.
    // So seek target to: target_pos + source_bar_phase.
    // This puts target at the right bar phase from the start.
    {
        float src_now = 0.0f;
        ma_sound_get_cursor_in_seconds(&source->sound, &src_now);
        // Source position after 100ms warmup
        float src_future = src_now + 0.1f;
        // Source's bar phase at that time
        float src_phase = fmodf(src_future - source_beat, bar_duration);
        if (src_phase < 0) src_phase += bar_duration;
        // Target should be at target_pos (a bar start) + src_phase
        target_pos = target_pos + src_phase;
        float dur = dj_get_duration(target);
        if (dur > 0 && target_pos > dur) target_pos = fmodf(target_pos, dur);
        fprintf(stderr, "[sync_mc] seek tgt=%.4f (base + src_phase=%.4f) src_now=%.4f\n",
                target_pos, src_phase, src_now);
    }

    // Step 1: Seek and start muted
    dj_seek(target, target_pos);
    ma_sound_set_volume(&target->sound, 0.0f);
    ma_sound_set_start_time_in_pcm_frames(&target->sound, 0);
    ma_result r = ma_sound_start(&target->sound);
    if (r != MA_SUCCESS) {
        ma_sound_set_volume(&target->sound, target->volume);
        fprintf(stderr, "[sync_mc] start failed (%d)\n", r);
        return -1;
    }

    // Step 2: Wait 100ms for RB to stabilize
    ma_uint64 wait_start = ma_engine_get_time_in_pcm_frames(engine);
    ma_uint64 wait_frames = sample_rate / 10;
    while (ma_engine_get_time_in_pcm_frames(engine) < wait_start + wait_frames) {
        ma_yield();
    }

    // Step 3: Measure actual phase error.
    // Both tracks should be at the same bar-phase. Compute each track's
    // phase within a bar relative to their respective reference beats.
    float src_pos = 0.0f, tgt_pos = 0.0f;
    ma_sound_get_cursor_in_seconds(&source->sound, &src_pos);
    ma_sound_get_cursor_in_seconds(&target->sound, &tgt_pos);

    // Use the SAME reference point for both: source_beat.
    // Both tracks share the same beat grid (same or synced BPM).
    float src_phase = fmodf(src_pos - source_beat, bar_duration);
    if (src_phase < 0) src_phase += bar_duration;
    float tgt_phase = fmodf(tgt_pos - source_beat, bar_duration);
    if (tgt_phase < 0) tgt_phase += bar_duration;

    // The error: how much target needs to shift to match source's bar phase
    float phase_error = src_phase - tgt_phase;
    if (phase_error > bar_duration / 2) phase_error -= bar_duration;
    if (phase_error < -bar_duration / 2) phase_error += bar_duration;

    // Step 4: Correct read_cursor by the exact measured error
    if (fabsf(phase_error) > 0.0001f && target->source) {
        int correction = (int)(phase_error * (float)sample_rate / target->source->time_ratio);
        ma_int64 corrected = (ma_int64)target->source->read_cursor + correction;
        if (corrected < 0) corrected = 0;
        if ((ma_uint64)corrected > target->source->total_frames)
            corrected = (ma_int64)target->source->total_frames;
        target->source->read_cursor = (ma_uint64)corrected;
    }

    // Step 5: Unmute
    ma_sound_set_volume(&target->sound, target->volume);

    // Step 6: Set phase origins for output-frame-based sync measurement.
    // After correction, both tracks are at the same bar-phase.
    // Compute source's current bar-phase in output frames and set origins so that
    // (output_frame_count - phase_origin) % bar_frames gives the same value for both.
    ma_uint64 bar_frames = (ma_uint64)(bar_duration * (float)sample_rate);
    if (bar_frames > 0) {
        // Source's bar-phase in seconds (after correction)
        float corrected_src_pos = 0.0f;
        ma_sound_get_cursor_in_seconds(&source->sound, &corrected_src_pos);
        float src_bar_phase_sec = fmodf(corrected_src_pos - source_beat, bar_duration);
        if (src_bar_phase_sec < 0) src_bar_phase_sec += bar_duration;
        ma_uint64 phase_in_frames = (ma_uint64)(src_bar_phase_sec * (float)sample_rate);

        // origin = output_frame_count - phase_in_frames
        // (so that (ofc - origin) % bar_frames == phase_in_frames)
        source->source->phase_bar_frames = bar_frames;
        source->source->phase_origin = source->source->output_frame_count - phase_in_frames;
        source->source->phase_partner = target->source;

        target->source->phase_bar_frames = bar_frames;
        target->source->phase_origin = target->source->output_frame_count - phase_in_frames;
        target->source->phase_partner = source->source;
    }

    fprintf(stderr, "[sync_mc] src=%.4f tgt=%.4f err=%.2fms correction=%d\n",
            src_pos, tgt_pos, phase_error * 1000,
            (fabsf(phase_error) > 0.0001f && target->source)
                ? (int)(phase_error * (float)sample_rate / target->source->time_ratio) : 0);
    return 0;
}

int dj_schedule_sync_play(void* target_sound, float target_seconds,
                          void* source_sound, float source_seconds) {
    if (!target_sound || !source_sound) return -1;
    DJSound* target = (DJSound*)target_sound;
    DJSound* source = (DJSound*)source_sound;

    if (target->engine != source->engine) {
        dj_seek(target_sound, target_seconds);
        return dj_play(target_sound);
    }

    ma_engine* engine = &source->engine->engine;
    ma_uint32 sample_rate = ma_engine_get_sample_rate(engine);

    // Match tempo
    if (source->original_bpm > 0 && target->original_bpm > 0) {
        float source_effective_bpm = source->original_bpm * dj_get_tempo(source_sound);
        float ratio = source_effective_bpm / target->original_bpm;
        dj_set_tempo(target_sound, ratio);
    }

    float source_pos = 0.0f;
    ma_sound_get_cursor_in_seconds(&source->sound, &source_pos);

    float seconds_until_trigger = source_seconds - source_pos;
    if (seconds_until_trigger <= 0) {
        target_seconds += (-seconds_until_trigger);
    }

    // Compute bar_duration from BPM for the phase measurement
    float bar_duration = 0.0f;
    if (source->original_bpm > 0) {
        float effective_bpm = source->original_bpm * dj_get_tempo(source_sound);
        bar_duration = 4.0f * 60.0f / effective_bpm;
    }
    if (bar_duration <= 0) bar_duration = 2.0f; // fallback

    // Always use measure-and-correct for exact sync.
    // target_seconds is already adjusted for overshoot if trigger was in the past.
    int result = sync_measure_correct(target, source, target_seconds, source_seconds, bar_duration);
    if (result == 0) target->scheduled = 0;
    return result;
}

int dj_sync_start(void* target_sound, float target_beat,
                   void* source_sound, float source_beat, float bar_duration,
                   int preserve_transport) {
    if (!target_sound || !source_sound) {
        fprintf(stderr, "[sync_start] ERROR: null sound pointer\n");
        return -1;
    }
    DJSound* target = (DJSound*)target_sound;
    DJSound* source = (DJSound*)source_sound;

    // Stop & reset target
    ma_sound_stop(&target->sound);
    ma_sound_set_start_time_in_pcm_frames(&target->sound, 0);
    target->scheduled = 0;

    // Match tempo
    if (source->original_bpm > 0 && target->original_bpm > 0) {
        float source_effective_bpm = source->original_bpm * dj_get_tempo(source_sound);
        float ratio = source_effective_bpm / target->original_bpm;
        dj_set_tempo(target_sound, ratio);
    }

    // Compute target position
    float source_pos = 0.0f;
    ma_sound_get_cursor_in_seconds(&source->sound, &source_pos);
    float offset = source_pos - source_beat;
    float phase = 0.0f;
    if (bar_duration > 0.0f) {
        phase = fmodf(offset, bar_duration);
        if (phase < 0) phase += bar_duration;
    }
    float target_offset = preserve_transport ? fmaxf(offset, 0.0f) : phase;
    float target_pos = target_beat + target_offset;
    float target_duration = dj_get_duration(target_sound);
    if (target_pos < 0.0f) target_pos = 0.0f;
    if (target_duration > 0.0f && target_pos > target_duration) target_pos = target_duration;

    // Use measure-and-correct for exact sync
    int result = sync_measure_correct(target, source, target_pos, source_beat, bar_duration);

    fprintf(stderr, "[sync_start] src=%.4f tgt=%.4f result=%d\n", source_pos, target_pos, result);
    return result;
}

int dj_cancel_scheduled_start(void* sound) {
    if (!sound) return -1;
    DJSound* snd = (DJSound*)sound;
    ma_sound_stop(&snd->sound);
    ma_sound_set_start_time_in_pcm_frames(&snd->sound, 0);
    return 0;
}

float dj_get_sync_diff(void* sound1, void* sound2, float beat_ref, float bar_duration) {
    if (!sound1 || !sound2 || bar_duration <= 0) return 0.0f;
    DJSound* s1 = (DJSound*)sound1;
    DJSound* s2 = (DJSound*)sound2;

    // Use pre-computed phase diff from the audio callback (race-free)
    if (s1->source && s2->source &&
        s1->source->phase_bar_frames > 0 && s1->source->phase_partner == s2->source) {
        return atomic_load_explicit(&s1->source->phase_diff, memory_order_relaxed);
    }
    if (s2->source && s1->source &&
        s2->source->phase_bar_frames > 0 && s2->source->phase_partner == s1->source) {
        return -atomic_load_explicit(&s2->source->phase_diff, memory_order_relaxed);
    }

    // Fallback: cursor-based estimation (less precise)
    float p1 = 0.0f, p2 = 0.0f;
    ma_sound_get_cursor_in_seconds(&s1->sound, &p1);
    ma_sound_get_cursor_in_seconds(&s2->sound, &p2);
    float phase1 = fmodf(p1 - beat_ref, bar_duration);
    float phase2 = fmodf(p2 - beat_ref, bar_duration);
    if (phase1 < 0) phase1 += bar_duration;
    if (phase2 < 0) phase2 += bar_duration;
    float diff = phase1 - phase2;
    if (diff > bar_duration / 2) diff -= bar_duration;
    if (diff < -bar_duration / 2) diff += bar_duration;
    return diff;
}

// --- EQ (3-band gain: 0=kill, 1=unity, 2=boost) ---

void dj_set_eq(void* sound, float lo, float mid, float hi) {
    if (!sound) return;
    DJSound* snd = (DJSound*)sound;
    snd->eq_lo = lo;
    snd->eq_mid = mid;
    snd->eq_hi = hi;
    // Cancel EQ automations on manual override
    snd->automations[DJ_PARAM_EQ_LO].active = 0;
    snd->automations[DJ_PARAM_EQ_MID].active = 0;
    snd->automations[DJ_PARAM_EQ_HI].active = 0;
}

float dj_get_eq_lo(void* sound) {
    if (!sound) return 1.0f;
    return ((DJSound*)sound)->eq_lo;
}

float dj_get_eq_mid(void* sound) {
    if (!sound) return 1.0f;
    return ((DJSound*)sound)->eq_mid;
}

float dj_get_eq_hi(void* sound) {
    if (!sound) return 1.0f;
    return ((DJSound*)sound)->eq_hi;
}

// --- DJ filter (single knob LP/HP sweep) ---

void dj_set_filter(void* sound, float value) {
    if (!sound) return;
    DJSound* snd = (DJSound*)sound;
    if (value < 0.0f) value = 0.0f;
    if (value > 1.0f) value = 1.0f;
    snd->filter_value = value;
    // Cancel filter automation if user manually sets filter
    snd->automations[DJ_PARAM_FILTER].active = 0;
}

float dj_get_filter(void* sound) {
    if (!sound) return 0.5f;
    DJSound* snd = (DJSound*)sound;
    return snd->filter_value;
}

// --- Parameter automation ---

void dj_set_automation(void* sound, int param, float start_val, float end_val,
                       float duration_seconds, int interp) {
    if (!sound || param < 0 || param >= DJ_PARAM_COUNT) return;
    DJSound* snd = (DJSound*)sound;
    DJAutomation* a = &snd->automations[param];

    a->start_value = start_val;
    a->end_value = end_val;
    a->interp = interp;

    if (snd->source) {
        ma_uint32 sr = snd->source->sample_rate;
        a->start_frame = snd->source->output_frame_count;
        a->duration_frames = (ma_uint64)(duration_seconds * sr);
    } else {
        a->start_frame = 0;
        a->duration_frames = 0;
    }
    a->current_value = start_val;

    // Apply start value immediately
    if (param == DJ_PARAM_FILTER) {
        snd->filter_value = start_val;
    } else if (param == DJ_PARAM_VOLUME) {
        ma_sound_set_volume(&snd->sound, start_val);
    } else if (param == DJ_PARAM_EQ_LO) {
        snd->eq_lo = start_val;
    } else if (param == DJ_PARAM_EQ_MID) {
        snd->eq_mid = start_val;
    } else if (param == DJ_PARAM_EQ_HI) {
        snd->eq_hi = start_val;
    }

    a->active = 1;
    printf("[automation] param=%d start=%.3f end=%.3f dur=%.3fs interp=%d\n",
           param, start_val, end_val, duration_seconds, interp);
}

void dj_cancel_automation(void* sound, int param) {
    if (!sound || param < 0 || param >= DJ_PARAM_COUNT) return;
    DJSound* snd = (DJSound*)sound;
    snd->automations[param].active = 0;
}

float dj_get_automation_value(void* sound, int param) {
    if (!sound || param < 0 || param >= DJ_PARAM_COUNT) return -1.0f;
    DJSound* snd = (DJSound*)sound;
    DJAutomation* a = &snd->automations[param];
    if (!a->active) return -1.0f;
    return a->current_value;
}

int dj_is_automation_active(void* sound, int param) {
    if (!sound || param < 0 || param >= DJ_PARAM_COUNT) return 0;
    DJSound* snd = (DJSound*)sound;
    return snd->automations[param].active;
}

// --- Loop control ---

void dj_set_loop(void* sound, float start_seconds, float end_seconds) {
    if (!sound) return;
    DJSound* snd = (DJSound*)sound;
    if (!snd->source) return;
    ma_uint32 sr = snd->source->sample_rate;
    snd->source->loop_start_frame = (ma_uint64)(start_seconds * (float)sr);
    snd->source->loop_end_frame = (ma_uint64)(end_seconds * (float)sr);
    snd->source->loop_active = 1;
    // Compute exact output-frame loop duration
    // Output duration = input duration * time_ratio (Rubber Band stretching)
    double input_duration_frames = (double)(snd->source->loop_end_frame - snd->source->loop_start_frame);
    snd->source->loop_output_duration = (ma_uint64)(input_duration_frames * snd->source->time_ratio);
    snd->source->loop_output_tracking = 0; // will be set on first entry
}

void dj_clear_loop(void* sound) {
    if (!sound) return;
    DJSound* snd = (DJSound*)sound;
    if (!snd->source) return;
    snd->source->loop_active = 0;
    snd->source->loop_output_tracking = 0;
}

int dj_is_looping(void* sound) {
    if (!sound) return 0;
    DJSound* snd = (DJSound*)sound;
    if (!snd->source) return 0;
    return snd->source->loop_active;
}

// --- Level metering (real RMS) ---

float dj_get_level(void* sound) {
    if (!sound) return 0.0f;
    DJSound* snd = (DJSound*)sound;
    if (!ma_sound_is_playing(&snd->sound)) return 0.0f;
    DJStretchedSource* src = snd->source;
    if (!src || src->rms_count == 0) return 0.0f;
    float rms = (float)sqrt(src->rms_sum / (double)src->rms_count);
    // Reset for next measurement window
    src->rms_sum = 0;
    src->rms_count = 0;
    return rms * snd->volume;
}

// --- Waveform peaks ---

int dj_get_peaks(const char* filepath, float* out_peaks, int num_points) {
    if (!filepath || !out_peaks || num_points <= 0) return -1;

    ma_decoder decoder;
    ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 1, 44100);

    if (ma_decoder_init_file(filepath, &config, &decoder) != MA_SUCCESS) {
        return -1;
    }

    ma_uint64 total_frames = 0;
    ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);

    if (total_frames == 0) {
        ma_decoder_uninit(&decoder);
        return -2;
    }

    double frames_per_point_f = (double)total_frames / (double)num_points;

    #define CHUNK_SIZE 4096
    float buffer[CHUNK_SIZE];

    int point_index = 0;
    float current_max = 0.0f;
    ma_uint64 global_frame = 0;
    double next_boundary = frames_per_point_f;

    while (point_index < num_points) {
        ma_uint64 frames_read = 0;

        if (ma_decoder_read_pcm_frames(&decoder, buffer, CHUNK_SIZE, &frames_read) != MA_SUCCESS || frames_read == 0) {
            break;
        }

        for (ma_uint64 i = 0; i < frames_read && point_index < num_points; i++) {
            float val = fabsf(buffer[i]);
            if (val > current_max) current_max = val;

            global_frame++;
            if ((double)global_frame >= next_boundary) {
                out_peaks[point_index] = current_max;
                point_index++;
                current_max = 0.0f;
                next_boundary = (double)(point_index + 1) * frames_per_point_f;
            }
        }
    }

    while (point_index < num_points) {
        out_peaks[point_index] = current_max;
        point_index++;
        current_max = 0.0f;
    }

    ma_decoder_uninit(&decoder);
    return 0;
}

// --- Butterworth filter implementations ---

static void lp_init(LPFilter* f, float cutoff_hz, float samplerate) {
    float w0 = 2.0f * (float)M_PI * cutoff_hz / samplerate;
    float cosw0 = cosf(w0);
    float sinw0 = sinf(w0);
    float alpha = sinw0 / (2.0f * 0.7071f);
    float a0 = 1.0f + alpha;
    f->b0 = ((1.0f - cosw0) / 2.0f) / a0;
    f->b1 = (1.0f - cosw0) / a0;
    f->b2 = f->b0;
    f->a1 = (-2.0f * cosw0) / a0;
    f->a2 = (1.0f - alpha) / a0;
    f->x1 = f->x2 = f->y1 = f->y2 = 0.0f;
}

static float lp_process(LPFilter* f, float x) {
    float y = f->b0 * x + f->b1 * f->x1 + f->b2 * f->x2
            - f->a1 * f->y1 - f->a2 * f->y2;
    f->x2 = f->x1; f->x1 = x;
    f->y2 = f->y1; f->y1 = y;
    return y;
}

static void hp_init(HPFilter* f, float cutoff_hz, float samplerate) {
    float w0 = 2.0f * (float)M_PI * cutoff_hz / samplerate;
    float cosw0 = cosf(w0);
    float sinw0 = sinf(w0);
    float alpha = sinw0 / (2.0f * 0.7071f);
    float a0 = 1.0f + alpha;
    f->b0 = ((1.0f + cosw0) / 2.0f) / a0;
    f->b1 = -(1.0f + cosw0) / a0;
    f->b2 = f->b0;
    f->a1 = (-2.0f * cosw0) / a0;
    f->a2 = (1.0f - alpha) / a0;
    f->x1 = f->x2 = f->y1 = f->y2 = 0.0f;
}

static float hp_process(HPFilter* f, float x) {
    float y = f->b0 * x + f->b1 * f->x1 + f->b2 * f->x2
            - f->a1 * f->y1 - f->a2 * f->y2;
    f->x2 = f->x1; f->x1 = x;
    f->y2 = f->y1; f->y1 = y;
    return y;
}

int dj_get_peaks_3band(const char* filepath, float* out_peaks, int num_points) {
    if (!filepath || !out_peaks || num_points <= 0) return -1;

    ma_decoder decoder;
    ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 1, 44100);
    if (ma_decoder_init_file(filepath, &config, &decoder) != MA_SUCCESS) return -1;

    ma_uint64 total_frames = 0;
    ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);
    if (total_frames == 0) { ma_decoder_uninit(&decoder); return -2; }

    // Use floating-point boundary tracking to avoid cumulative rounding error
    double frames_per_point = (double)total_frames / (double)num_points;

    // Low-pass at 250Hz (kick/bass)
    LPFilter lp1, lp2;
    lp_init(&lp1, 250.0f, 44100.0f);
    lp_init(&lp2, 250.0f, 44100.0f);

    // High-pass at 4000Hz (hats/cymbals)
    HPFilter hp1, hp2;
    hp_init(&hp1, 4000.0f, 44100.0f);
    hp_init(&hp2, 4000.0f, 44100.0f);

    #define PEAK3_CHUNK 4096
    float buffer[PEAK3_CHUNK];
    int point_index = 0;
    float max_lo = 0.0f, max_mid = 0.0f, max_hi = 0.0f;
    ma_uint64 global_frame = 0;
    double next_boundary = frames_per_point; // when to emit next peak

    while (point_index < num_points) {
        ma_uint64 frames_read = 0;
        if (ma_decoder_read_pcm_frames(&decoder, buffer, PEAK3_CHUNK, &frames_read) != MA_SUCCESS || frames_read == 0)
            break;

        for (ma_uint64 i = 0; i < frames_read && point_index < num_points; i++) {
            float sample = buffer[i];
            float lo = lp_process(&lp2, lp_process(&lp1, sample));
            float hi = hp_process(&hp2, hp_process(&hp1, sample));
            float mid = sample - lo - hi;

            float abs_lo = fabsf(lo);
            float abs_mid = fabsf(mid);
            float abs_hi = fabsf(hi);

            if (abs_lo > max_lo) max_lo = abs_lo;
            if (abs_mid > max_mid) max_mid = abs_mid;
            if (abs_hi > max_hi) max_hi = abs_hi;

            global_frame++;
            if ((double)global_frame >= next_boundary) {
                out_peaks[point_index * 3 + 0] = max_lo;
                out_peaks[point_index * 3 + 1] = max_mid;
                out_peaks[point_index * 3 + 2] = max_hi;
                point_index++;
                max_lo = max_mid = max_hi = 0.0f;
                next_boundary = (double)(point_index + 1) * frames_per_point;
            }
        }
    }

    while (point_index < num_points) {
        out_peaks[point_index * 3 + 0] = max_lo;
        out_peaks[point_index * 3 + 1] = max_mid;
        out_peaks[point_index * 3 + 2] = max_hi;
        point_index++;
        max_lo = max_mid = max_hi = 0.0f;
    }

    ma_decoder_uninit(&decoder);
    return 0;
}

// --- PCM transient detection (shared by BPM and beat detection) ---

#define BEAT_SAMPLERATE 44100
#define MAX_TRANSIENTS 500

// Find first N transients in mono PCM via low-pass filtered envelope follower.
// Low-pass at 200Hz isolates kick drum before transient detection.
static int find_pcm_transients(const float* pcm, ma_uint64 total_frames,
                               float* out_times, int max_out) {
    // Two cascaded 2nd-order filters = 4th-order Butterworth (-24dB/oct)
    LPFilter lp1, lp2;
    lp_init(&lp1, 200.0f, (float)BEAT_SAMPLERATE);
    lp_init(&lp2, 200.0f, (float)BEAT_SAMPLERATE);

    int count = 0;
    float last_time = -1.0f;
    int in_transient = 0;
    float envelope = 0.0f;
    float threshold = 0.02f;
    float min_interval = 0.2f; // 200ms minimum (~300 BPM max)
    float attack = 0.005f;
    float release = 0.0005f;

    for (ma_uint64 i = 0; i < total_frames && count < max_out; i++) {
        // Filter to isolate kick
        float filtered = lp_process(&lp2, lp_process(&lp1, pcm[i]));
        float sample = fabsf(filtered);

        if (sample > envelope)
            envelope += attack * (sample - envelope);
        else
            envelope += release * (sample - envelope);

        float t = (float)i / (float)BEAT_SAMPLERATE;

        if (!in_transient && envelope > threshold) {
            if (last_time < 0 || (t - last_time) > min_interval) {
                // Walk back on filtered signal to find exact onset
                // (can't walk back through filter, so use current position)
                out_times[count++] = t;
                last_time = t;
            }
            in_transient = 1;
        } else if (in_transient && envelope < threshold * 0.5f) {
            in_transient = 0;
        }
    }
    return count;
}

// --- BPM detection ---
// Uses PCM transient detection for accurate BPM, with aubio as fallback.

float dj_detect_bpm(const char* filepath) {
    if (!filepath) return 0.0f;

    // Try PCM transient approach first
    ma_decoder decoder;
    ma_decoder_config dconfig = ma_decoder_config_init(ma_format_f32, 1, BEAT_SAMPLERATE);
    if (ma_decoder_init_file(filepath, &dconfig, &decoder) != MA_SUCCESS) return 0.0f;

    ma_uint64 total_frames = 0;
    ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);
    if (total_frames == 0) { ma_decoder_uninit(&decoder); return 0.0f; }

    float* pcm = (float*)malloc(total_frames * sizeof(float));
    if (!pcm) { ma_decoder_uninit(&decoder); return 0.0f; }

    ma_uint64 frames_read = 0;
    ma_decoder_read_pcm_frames(&decoder, pcm, total_frames, &frames_read);
    ma_decoder_uninit(&decoder);

    float transients[MAX_TRANSIENTS];
    int n_trans = find_pcm_transients(pcm, frames_read, transients, MAX_TRANSIENTS);
    free(pcm);

    if (n_trans >= 3) {
        // Compute BPM from median interval
        float intervals[MAX_TRANSIENTS];
        int n_intervals = 0;
        for (int i = 1; i < n_trans; i++) {
            float interval = transients[i] - transients[i - 1];
            if (interval >= 0.3f && interval <= 1.0f) {
                intervals[n_intervals++] = interval;
            }
        }
        if (n_intervals >= 2) {
            for (int i = 0; i < n_intervals - 1; i++)
                for (int j = i + 1; j < n_intervals; j++)
                    if (intervals[j] < intervals[i]) {
                        float tmp = intervals[i]; intervals[i] = intervals[j]; intervals[j] = tmp;
                    }
            // Refine: mean of intervals within 1ms of median
            float med = intervals[n_intervals / 2];
            double csum = 0; int ccount = 0;
            for (int i = 0; i < n_intervals; i++) {
                if (fabsf(intervals[i] - med) < 0.001f) { csum += intervals[i]; ccount++; }
            }
            return 60.0f / (ccount > 0 ? (float)(csum / ccount) : med);
        }
    }

    // Fallback: aubio tempo detection
    if (ma_decoder_init_file(filepath, &dconfig, &decoder) != MA_SUCCESS) return 0.0f;

    aubio_tempo_t* tempo = new_aubio_tempo("default", 1024, 512, BEAT_SAMPLERATE);
    if (!tempo) { ma_decoder_uninit(&decoder); return 0.0f; }

    fvec_t* input = new_fvec(512);
    fvec_t* output = new_fvec(1);
    float buffer[512];
    float last_bpm = 0.0f;

    while (1) {
        ma_uint64 fr = 0;
        if (ma_decoder_read_pcm_frames(&decoder, buffer, 512, &fr) != MA_SUCCESS || fr == 0) break;
        for (uint_t i = 0; i < fr; i++) input->data[i] = buffer[i];
        for (uint_t i = (uint_t)fr; i < 512; i++) input->data[i] = 0.0f;
        aubio_tempo_do(tempo, input, output);
        float bpm = aubio_tempo_get_bpm(tempo);
        if (bpm > 0.0f) last_bpm = bpm;
    }

    del_fvec(input);
    del_fvec(output);
    del_aubio_tempo(tempo);
    ma_decoder_uninit(&decoder);
    return last_bpm;
}

// --- Beat detection ---
// 1. Get rough BPM from transients
// 2. Pre-filter PCM to low band (matches waveform display)
// 3. Fine-scan BPM + phase by maximizing on-beat energy across entire track
// 4. Generate grid

// Helper: compute total energy at beat positions for a given interval + phase
static double beat_energy(const float* energy, int n_energy, double duration,
                          double interval, double phase) {
    double sum = 0;
    int window = 3; // +/- 3 energy bins (~12ms at 2ms resolution)
    for (double t = phase; t < duration; t += interval) {
        int idx = (int)((t / duration) * n_energy);
        for (int j = -window; j <= window; j++) {
            int k = idx + j;
            if (k >= 0 && k < n_energy) sum += energy[k];
        }
    }
    return sum;
}

int dj_detect_beats(const char* filepath, float* out_beats, int max_beats) {
    if (!filepath || !out_beats || max_beats <= 0) return 0;

    // Decode entire file to mono PCM
    ma_decoder decoder;
    ma_decoder_config dconfig = ma_decoder_config_init(ma_format_f32, 1, BEAT_SAMPLERATE);
    if (ma_decoder_init_file(filepath, &dconfig, &decoder) != MA_SUCCESS) return 0;

    ma_uint64 total_frames = 0;
    ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);
    if (total_frames == 0) { ma_decoder_uninit(&decoder); return 0; }

    float duration = (float)total_frames / (float)BEAT_SAMPLERATE;

    float* pcm = (float*)malloc(total_frames * sizeof(float));
    if (!pcm) { ma_decoder_uninit(&decoder); return 0; }

    ma_uint64 frames_read = 0;
    ma_decoder_read_pcm_frames(&decoder, pcm, total_frames, &frames_read);
    ma_decoder_uninit(&decoder);

    if (frames_read == 0) { free(pcm); return 0; }

    // --- Step 1: Get rough BPM from transients ---
    float transients[MAX_TRANSIENTS];
    int n_trans = find_pcm_transients(pcm, frames_read, transients, MAX_TRANSIENTS);

    float rough_bpm = 0;
    if (n_trans >= 3) {
        float intervals[MAX_TRANSIENTS];
        int n_iv = 0;
        for (int i = 1; i < n_trans; i++) {
            float iv = transients[i] - transients[i-1];
            if (iv >= 0.3f && iv <= 1.0f) intervals[n_iv++] = iv;
        }
        if (n_iv >= 2) {
            // Sort and take median
            for (int i = 0; i < n_iv-1; i++)
                for (int j = i+1; j < n_iv; j++)
                    if (intervals[j] < intervals[i]) {
                        float tmp = intervals[i]; intervals[i] = intervals[j]; intervals[j] = tmp;
                    }
            rough_bpm = 60.0f / intervals[n_iv / 2];
        }
    }
    if (rough_bpm <= 0) { free(pcm); return 0; }

    // --- Step 2: Build onset strength array ---
    // LP filter, compute energy per window, then take positive derivative (rise = onset)
    LPFilter el1, el2;
    lp_init(&el1, 250.0f, (float)BEAT_SAMPLERATE);
    lp_init(&el2, 250.0f, (float)BEAT_SAMPLERATE);

    int energy_window = BEAT_SAMPLERATE / 500; // ~2ms windows
    int n_energy = (int)(frames_read / energy_window);
    if (n_energy < 10) { free(pcm); return 0; }

    float* raw_energy = (float*)calloc(n_energy, sizeof(float));
    float* energy = (float*)calloc(n_energy, sizeof(float));
    if (!raw_energy || !energy) { free(pcm); free(raw_energy); free(energy); return 0; }

    for (ma_uint64 i = 0; i < frames_read; i++) {
        float filtered = lp_process(&el2, lp_process(&el1, pcm[i]));
        int bin = (int)(i / energy_window);
        if (bin < n_energy) raw_energy[bin] += filtered * filtered;
    }
    free(pcm);

    // Onset strength = positive half-wave rectified derivative of energy
    // Used for BPM detection (emphasizes kick transients)
    energy[0] = 0;
    for (int i = 1; i < n_energy; i++) {
        float diff = raw_energy[i] - raw_energy[i-1];
        energy[i] = diff > 0 ? diff : 0;
    }
    // raw_energy kept for phase alignment (matches waveform display)

    // --- Step 3: Two-pass BPM + phase scan ---
    // Pass 1: Coarse scan ±2 BPM in 0.1 steps
    double best_interval = 60.0 / rough_bpm;
    double best_phase = 0;
    double best_score = 0;

    for (double bpm_try = rough_bpm - 2.0; bpm_try <= rough_bpm + 2.0; bpm_try += 0.05) {
        if (bpm_try <= 0) continue;
        double iv = 60.0 / bpm_try;
        int phase_steps = (int)(iv * 500); // 2ms steps
        for (int p = 0; p < phase_steps; p++) {
            double ph = p * 0.002;
            double score = beat_energy(energy, n_energy, duration, iv, ph);
            if (score > best_score) {
                best_score = score;
                best_interval = iv;
                best_phase = ph;
            }
        }
    }

    // Pass 2: Fine BPM scan using onset strength
    double coarse_bpm = 60.0 / best_interval;
    double coarse_phase = best_phase;
    best_score = 0;

    for (double bpm_try = coarse_bpm - 0.5; bpm_try <= coarse_bpm + 0.5; bpm_try += 0.001) {
        if (bpm_try <= 0) continue;
        double iv = 60.0 / bpm_try;
        for (int p = -10; p <= 10; p++) {
            double ph = coarse_phase + p * 0.0005;
            if (ph < 0) ph += iv;
            if (ph >= iv) ph -= iv;
            double score = beat_energy(energy, n_energy, duration, iv, ph);
            if (score > best_score) {
                best_score = score;
                best_interval = iv;
                best_phase = ph;
            }
        }
    }

    free(energy);

    free(raw_energy);

    // Pass 3: Sample-level drift correction (iterated).
    // Re-decode, LP filter, find exact peak sample near each beat, regress to correct interval.
    // Run 3 iterations to converge.
    {
        ma_decoder dec3;
        ma_decoder_config dc3 = ma_decoder_config_init(ma_format_f32, 1, BEAT_SAMPLERATE);
        if (ma_decoder_init_file(filepath, &dc3, &dec3) == MA_SUCCESS) {
            ma_uint64 tf3 = 0;
            ma_decoder_get_length_in_pcm_frames(&dec3, &tf3);
            float* pcm3 = (float*)malloc(tf3 * sizeof(float));
            if (pcm3) {
                ma_uint64 fr3 = 0;
                ma_decoder_read_pcm_frames(&dec3, pcm3, tf3, &fr3);

                // LP filter to match peak display (250Hz, 4th order)
                LPFilter dl1, dl2;
                lp_init(&dl1, 250.0f, (float)BEAT_SAMPLERATE);
                lp_init(&dl2, 250.0f, (float)BEAT_SAMPLERATE);
                for (ma_uint64 i = 0; i < fr3; i++) {
                    pcm3[i] = lp_process(&dl2, lp_process(&dl1, pcm3[i]));
                }

                float global_max = 0;
                for (ma_uint64 i = 0; i < fr3; i++) {
                    float v = fabsf(pcm3[i]);
                    if (v > global_max) global_max = v;
                }
                float thresh = global_max * 0.3f;

                // Iterate 3 times to converge
                for (int iter = 0; iter < 3; iter++) {
                    int search_samples = BEAT_SAMPLERATE / 10; // ±100ms
                    double sx3 = 0, sy3 = 0, sxy3 = 0, sx3_2 = 0;
                    int n3 = 0;

                    int beat_idx = 0;
                    for (double t = best_phase; t < duration; t += best_interval) {
                        ma_uint64 center = (ma_uint64)(t * BEAT_SAMPLERATE);
                        float peak_val = 0;
                        int peak_off = 0;
                        for (int j = -search_samples; j <= search_samples; j++) {
                            ma_uint64 k = center + j;
                            if (k < fr3) {
                                float v = fabsf(pcm3[k]);
                                if (v > peak_val) { peak_val = v; peak_off = j; }
                            }
                        }
                        if (peak_val > thresh) {
                            double x = (double)beat_idx;
                            double y = (double)peak_off / (double)BEAT_SAMPLERATE;
                            sx3 += x; sy3 += y; sxy3 += x * y; sx3_2 += x * x;
                            n3++;
                        }
                        beat_idx++;
                    }

                    if (n3 >= 20) {
                        double nd = (double)n3;
                        double drift = (nd * sxy3 - sx3 * sy3) / (nd * sx3_2 - sx3 * sx3);
                        double intercept = (sy3 - drift * sx3) / nd;
                        best_interval += drift;
                        best_phase += intercept;
                        while (best_phase < 0) best_phase += best_interval;
                        while (best_phase >= best_interval) best_phase -= best_interval;
                    }
                }

                free(pcm3);
            }
            ma_decoder_uninit(&dec3);
        }
    }

    // --- Step 4: Generate grid ---
    int beat_count = 0;
    double t = best_phase;
    while (t < duration && beat_count < max_beats) {
        out_beats[beat_count++] = (float)t;
        t += best_interval;
    }

    return beat_count;
}

// ============================================================
// MIDI (CoreMIDI) — ring buffer for lock-free message passing
// ============================================================

#define MIDI_RING_SIZE 512
#define MIDI_NAME_BUF 256

typedef struct {
    MIDIClientRef client;
    MIDIPortRef input_port;
    MIDIPortRef output_port;
    MIDIEndpointRef current_source;
    MIDIEndpointRef current_dest;
    int initialized;

    // Lock-free ring buffer (single producer, single consumer)
    DjMidiMessage ring[MIDI_RING_SIZE];
    _Atomic uint32_t write_idx;
    _Atomic uint32_t read_idx;

    // Source/dest name cache
    char source_names[64][MIDI_NAME_BUF];
    int source_count;
    char dest_names[64][MIDI_NAME_BUF];
    int dest_count;
} DjMidiGlobal;

static DjMidiGlobal g_midi = {0};

static void midi_get_endpoint_name(MIDIEndpointRef endpoint, char* buf, int bufsize) {
    CFStringRef name = NULL;
    MIDIObjectGetStringProperty(endpoint, kMIDIPropertyDisplayName, &name);
    if (!name) MIDIObjectGetStringProperty(endpoint, kMIDIPropertyName, &name);
    if (name) {
        CFStringGetCString(name, buf, bufsize, kCFStringEncodingUTF8);
        CFRelease(name);
    } else {
        buf[0] = '\0';
    }
}

// CoreMIDI read callback — runs on CoreMIDI's thread
static void midi_read_proc(const MIDIPacketList* pktList, void* readProcRefCon, void* srcConnRefCon) {
    (void)readProcRefCon;
    (void)srcConnRefCon;
    const MIDIPacket* pkt = &pktList->packet[0];
    for (UInt32 i = 0; i < pktList->numPackets; i++) {
        // Parse MIDI bytes
        for (UInt16 j = 0; j < pkt->length; ) {
            uint8_t status = pkt->data[j];
            if (status < 0x80) { j++; continue; } // skip data bytes
            uint8_t channel = status & 0x0F;
            uint8_t type = status & 0xF0;
            int data_bytes = 0;
            switch (type) {
                case 0x80: case 0x90: case 0xA0: case 0xB0: case 0xE0:
                    data_bytes = 2; break;
                case 0xC0: case 0xD0:
                    data_bytes = 1; break;
                case 0xF0:
                    // System messages — skip
                    j++; continue;
                default:
                    j++; continue;
            }
            if (j + 1 + data_bytes > pkt->length) break;

            uint8_t d1 = (data_bytes >= 1) ? pkt->data[j + 1] : 0;
            uint8_t d2 = (data_bytes >= 2) ? pkt->data[j + 2] : 0;

            // Write to ring buffer
            uint32_t wi = atomic_load_explicit(&g_midi.write_idx, memory_order_relaxed);
            uint32_t next_wi = (wi + 1) % MIDI_RING_SIZE;
            uint32_t ri = atomic_load_explicit(&g_midi.read_idx, memory_order_acquire);
            if (next_wi != ri) { // not full
                g_midi.ring[wi].status = type;
                g_midi.ring[wi].data1 = d1;
                g_midi.ring[wi].data2 = d2;
                g_midi.ring[wi].channel = channel;
                atomic_store_explicit(&g_midi.write_idx, next_wi, memory_order_release);
            }
            j += 1 + data_bytes;
        }
        pkt = MIDIPacketNext(pkt);
    }
}

int dj_midi_init(void) {
    if (g_midi.initialized) return 0;

    OSStatus status = MIDIClientCreate(CFSTR("JensDJ"), NULL, NULL, &g_midi.client);
    if (status != noErr) {
        fprintf(stderr, "[MIDI] MIDIClientCreate failed: %d\n", (int)status);
        return -1;
    }

    status = MIDIInputPortCreate(g_midi.client, CFSTR("JensDJ Input"), midi_read_proc, NULL, &g_midi.input_port);
    if (status != noErr) {
        fprintf(stderr, "[MIDI] MIDIInputPortCreate failed: %d\n", (int)status);
        MIDIClientDispose(g_midi.client);
        return -2;
    }

    status = MIDIOutputPortCreate(g_midi.client, CFSTR("JensDJ Output"), &g_midi.output_port);
    if (status != noErr) {
        fprintf(stderr, "[MIDI] MIDIOutputPortCreate failed (non-fatal): %d\n", (int)status);
        // Output is optional, don't fail
    }

    atomic_store(&g_midi.write_idx, 0);
    atomic_store(&g_midi.read_idx, 0);
    g_midi.current_source = 0;
    g_midi.current_dest = 0;

    // Enumerate sources
    g_midi.source_count = (int)MIDIGetNumberOfSources();
    if (g_midi.source_count > 64) g_midi.source_count = 64;
    for (int i = 0; i < g_midi.source_count; i++) {
        MIDIEndpointRef src = MIDIGetSource(i);
        midi_get_endpoint_name(src, g_midi.source_names[i], MIDI_NAME_BUF);
        fprintf(stderr, "[MIDI] Source %d: %s\n", i, g_midi.source_names[i]);
    }

    // Enumerate destinations
    g_midi.dest_count = (int)MIDIGetNumberOfDestinations();
    if (g_midi.dest_count > 64) g_midi.dest_count = 64;
    for (int i = 0; i < g_midi.dest_count; i++) {
        MIDIEndpointRef dst = MIDIGetDestination(i);
        midi_get_endpoint_name(dst, g_midi.dest_names[i], MIDI_NAME_BUF);
        fprintf(stderr, "[MIDI] Destination %d: %s\n", i, g_midi.dest_names[i]);
    }

    g_midi.initialized = 1;
    fprintf(stderr, "[MIDI] Initialized: %d sources, %d destinations\n",
            g_midi.source_count, g_midi.dest_count);
    return 0;
}

void dj_midi_shutdown(void) {
    if (!g_midi.initialized) return;
    dj_midi_close_input();
    dj_midi_close_output();
    if (g_midi.output_port) MIDIPortDispose(g_midi.output_port);
    if (g_midi.input_port) MIDIPortDispose(g_midi.input_port);
    MIDIClientDispose(g_midi.client);
    g_midi.initialized = 0;
}

int dj_midi_get_source_count(void) {
    return g_midi.source_count;
}

const char* dj_midi_get_source_name(int index) {
    if (index < 0 || index >= g_midi.source_count) return "";
    return g_midi.source_names[index];
}

int dj_midi_open_input(int source_index) {
    if (!g_midi.initialized) return -1;
    if (source_index < 0 || source_index >= g_midi.source_count) return -2;

    // Close existing connection
    dj_midi_close_input();

    MIDIEndpointRef src = MIDIGetSource(source_index);
    OSStatus status = MIDIPortConnectSource(g_midi.input_port, src, NULL);
    if (status != noErr) {
        fprintf(stderr, "[MIDI] MIDIPortConnectSource failed: %d\n", (int)status);
        return -3;
    }

    g_midi.current_source = src;
    fprintf(stderr, "[MIDI] Opened input: %s\n", g_midi.source_names[source_index]);
    return 0;
}

void dj_midi_close_input(void) {
    if (g_midi.current_source) {
        MIDIPortDisconnectSource(g_midi.input_port, g_midi.current_source);
        g_midi.current_source = 0;
    }
}

int dj_midi_poll(DjMidiMessage* out, int max_messages) {
    if (!out || max_messages <= 0) return 0;
    int count = 0;
    while (count < max_messages) {
        uint32_t ri = atomic_load_explicit(&g_midi.read_idx, memory_order_relaxed);
        uint32_t wi = atomic_load_explicit(&g_midi.write_idx, memory_order_acquire);
        if (ri == wi) break; // empty
        out[count] = g_midi.ring[ri];
        atomic_store_explicit(&g_midi.read_idx, (ri + 1) % MIDI_RING_SIZE, memory_order_release);
        count++;
    }
    return count;
}

int dj_midi_get_dest_count(void) {
    return g_midi.dest_count;
}

const char* dj_midi_get_dest_name(int index) {
    if (index < 0 || index >= g_midi.dest_count) return "";
    return g_midi.dest_names[index];
}

int dj_midi_open_output(int dest_index) {
    if (!g_midi.initialized) return -1;
    if (dest_index < 0 || dest_index >= g_midi.dest_count) return -2;
    dj_midi_close_output();
    g_midi.current_dest = MIDIGetDestination(dest_index);
    fprintf(stderr, "[MIDI] Opened output: %s\n", g_midi.dest_names[dest_index]);
    return 0;
}

int dj_midi_send(uint8_t status, uint8_t data1, uint8_t data2) {
    if (!g_midi.initialized || !g_midi.current_dest || !g_midi.output_port) return -1;
    Byte buffer[128];
    MIDIPacketList* pktList = (MIDIPacketList*)buffer;
    MIDIPacket* pkt = MIDIPacketListInit(pktList);
    Byte msg[3] = { status, data1, data2 };
    pkt = MIDIPacketListAdd(pktList, sizeof(buffer), pkt, 0, 3, msg);
    if (!pkt) return -2;
    OSStatus result = MIDISend(g_midi.output_port, g_midi.current_dest, pktList);
    return result == noErr ? 0 : -3;
}

void dj_midi_close_output(void) {
    g_midi.current_dest = 0;
}
