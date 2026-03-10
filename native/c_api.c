// c_api.c — Thin C wrappers for miniaudio static inline functions
// and deep struct accessors that can't be called directly from Zig.
#include "miniaudio.h"

// --- Config init wrappers (miniaudio uses static inline for these) ---

void dj_c_decoder_config_init(void* out, int format, unsigned int channels, unsigned int sampleRate) {
    *(ma_decoder_config*)out = ma_decoder_config_init((ma_format)format, channels, sampleRate);
}

void dj_c_engine_config_init(void* out) {
    *(ma_engine_config*)out = ma_engine_config_init();
}

void dj_c_engine_config_set_device(void* config, const void* device_id) {
    ((ma_engine_config*)config)->pPlaybackDeviceID = (const ma_device_id*)device_id;
}

void dj_c_data_source_config_init(void* out, const void* vtable) {
    ma_data_source_config config = ma_data_source_config_init();
    config.vtable = (const ma_data_source_vtable*)vtable;
    *(ma_data_source_config*)out = config;
}

// --- Device info accessors ---

unsigned long long dj_c_get_device_period(void* engine) {
    ma_device* device = ma_engine_get_device((ma_engine*)engine);
    return device ? device->playback.internalPeriodSizeInFrames : 0;
}

const char* dj_c_device_info_name(const void* info) {
    return ((const ma_device_info*)info)->name;
}

int dj_c_device_info_channels(const void* info) {
    const ma_device_info* di = (const ma_device_info*)info;
    if (di->nativeDataFormatCount > 0) return (int)di->nativeDataFormats[0].channels;
    return 2;
}

const void* dj_c_device_info_id(const void* info) {
    return &((const ma_device_info*)info)->id;
}

// --- Size queries (for runtime verification) ---

unsigned int dj_c_decoder_config_size(void) { return (unsigned int)sizeof(ma_decoder_config); }
unsigned int dj_c_engine_config_size(void) { return (unsigned int)sizeof(ma_engine_config); }
