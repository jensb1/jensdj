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
#include <stdlib.h>
#include <string.h>
#include <math.h>

// --- Internal types ---

#define MAX_DEVICES 64
#define RB_BLOCK_SIZE 1024
#define MAX_CHANNELS 2

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
typedef struct {
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
} DJStretchedSource;

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

            // Interleave into output
            for (unsigned int i = 0; i < retrieved; i++) {
                for (unsigned int ch = 0; ch < src->channels; ch++) {
                    out[(frames_written + i) * src->channels + ch] = src->deinterleaved_out[ch][i];
                }
            }
            frames_written += retrieved;
            continue;
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

        // Deinterleave input
        for (unsigned int i = 0; i < to_feed; i++) {
            for (unsigned int ch = 0; ch < src->channels; ch++) {
                src->deinterleaved_in[ch][i] = src->pcm_data[(src->read_cursor + i) * src->channels + ch];
            }
        }

        int is_final = (src->read_cursor + to_feed >= src->total_frames) ? 1 : 0;
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
    snd->eq_lo = 0.0f;
    snd->eq_mid = 0.0f;
    snd->eq_hi = 0.0f;
    snd->current_level = 0.0f;
    snd->original_bpm = 0.0f;

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
    return ma_sound_start(&snd->sound) == MA_SUCCESS ? 0 : -1;
}

int dj_pause(void* sound) {
    if (!sound) return -1;
    DJSound* snd = (DJSound*)sound;
    return ma_sound_stop(&snd->sound) == MA_SUCCESS ? 0 : -1;
}

int dj_stop(void* sound) {
    if (!sound) return -1;
    DJSound* snd = (DJSound*)sound;
    ma_sound_stop(&snd->sound);
    // Seek back to beginning
    dj_seek(sound, 0.0f);
    return 0;
}

int dj_seek(void* sound, float seconds) {
    if (!sound) return -1;
    DJSound* snd = (DJSound*)sound;
    ma_uint64 frame = (ma_uint64)(seconds * (float)snd->source->sample_rate);
    return ma_sound_seek_to_pcm_frame(&snd->sound, frame) == MA_SUCCESS ? 0 : -1;
}

float dj_get_position(void* sound) {
    if (!sound) return 0.0f;
    DJSound* snd = (DJSound*)sound;

    float cursor = 0.0f;
    ma_sound_get_cursor_in_seconds(&snd->sound, &cursor);
    return cursor;
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
    return ma_sound_is_playing(&snd->sound) ? 1 : 0;
}

void dj_set_volume(void* sound, float volume) {
    if (!sound) return;
    DJSound* snd = (DJSound*)sound;
    snd->volume = volume;
    ma_sound_set_volume(&snd->sound, volume);
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

    float source_pos = 0.0f;
    ma_sound_get_cursor_in_seconds(&source->sound, &source_pos);

    float seconds_until_trigger = source_seconds - source_pos;
    if (seconds_until_trigger < 0) {
        dj_seek(target_sound, target_seconds);
        return dj_play(target_sound);
    }

    ma_uint64 frames_until_trigger = (ma_uint64)(seconds_until_trigger * (float)sample_rate);
    ma_uint64 engine_time = ma_engine_get_time_in_pcm_frames(engine);
    ma_uint64 start_time = engine_time + frames_until_trigger;

    // Match tempo: if both tracks have BPM info, adjust target tempo
    if (source->original_bpm > 0 && target->original_bpm > 0) {
        float source_effective_bpm = source->original_bpm * dj_get_tempo(source_sound);
        float ratio = source_effective_bpm / target->original_bpm;
        dj_set_tempo(target_sound, ratio);
    }

    ma_uint64 target_frame = (ma_uint64)(target_seconds * (float)sample_rate);
    ma_sound_seek_to_pcm_frame(&target->sound, target_frame);
    ma_sound_set_start_time_in_pcm_frames(&target->sound, start_time);
    ma_sound_start(&target->sound);

    return 0;
}

int dj_cancel_scheduled_start(void* sound) {
    if (!sound) return -1;
    DJSound* snd = (DJSound*)sound;
    ma_sound_stop(&snd->sound);
    ma_sound_set_start_time_in_pcm_frames(&snd->sound, 0);
    return 0;
}

// --- EQ (simplified) ---

void dj_set_eq(void* sound, float lo, float mid, float hi) {
    if (!sound) return;
    DJSound* snd = (DJSound*)sound;
    snd->eq_lo = lo;
    snd->eq_mid = mid;
    snd->eq_hi = hi;
}

// --- Level metering ---

float dj_get_level(void* sound) {
    if (!sound) return 0.0f;
    DJSound* snd = (DJSound*)sound;
    if (!ma_sound_is_playing(&snd->sound)) return 0.0f;
    return snd->volume * 0.7f;
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

// --- Butterworth filter primitives (shared by 3-band peaks + transient detection) ---

// Low-pass filter (2nd order Butterworth)
typedef struct {
    float x1, x2, y1, y2;
    float b0, b1, b2, a1, a2;
} LPFilter;

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

// High-pass filter (2nd order Butterworth)
typedef struct {
    float x1, x2, y1, y2;
    float b0, b1, b2, a1, a2;
} HPFilter;

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
