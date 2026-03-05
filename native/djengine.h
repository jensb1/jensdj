#ifndef DJENGINE_H
#define DJENGINE_H

#ifdef __cplusplus
extern "C" {
#endif

// Lifecycle
int dj_init(void);
void dj_shutdown(void);

// Device enumeration
int dj_get_device_count(void);
const char* dj_get_device_name(int index);
int dj_get_device_channels(int index);

// Engine per output device
void* dj_create_engine(int device_index);  // -1 for default
void dj_destroy_engine(void* engine);

// Sound loading + playback
void* dj_load_sound(void* engine, const char* filepath);
void dj_unload_sound(void* sound);
int dj_play(void* sound);
int dj_pause(void* sound);
int dj_stop(void* sound);
int dj_seek(void* sound, float seconds);
float dj_get_position(void* sound);
float dj_get_duration(void* sound);
int dj_is_playing(void* sound);
void dj_set_volume(void* sound, float volume);

// EQ (3-band: lo, mid, hi — values in dB, 0 = unity)
void dj_set_eq(void* sound, float lo, float mid, float hi);

// Level metering (returns RMS 0..1)
float dj_get_level(void* sound);

// Scheduled sync playback
// Schedules target_sound to start playing from target_seconds,
// timed to the exact moment source_sound reaches source_seconds.
// Both sounds MUST be on the same engine. Returns 0 on success.
int dj_schedule_sync_play(void* target_sound, float target_seconds,
                          void* source_sound, float source_seconds);

// Cancel a previously scheduled start (before it fires)
int dj_cancel_scheduled_start(void* sound);

// Time-stretching (Rubber Band — preserves pitch)
// ratio: 1.0 = original tempo, 1.05 = 5% faster, 0.95 = 5% slower
void dj_set_tempo(void* sound, float ratio);
float dj_get_tempo(void* sound);
void dj_set_original_bpm(void* sound, float bpm);
float dj_get_original_bpm(void* sound);

// Waveform peaks extraction
// Decodes the file and writes num_points peak values (0..1) into out_peaks.
// Returns 0 on success, non-zero on error.
int dj_get_peaks(const char* filepath, float* out_peaks, int num_points);

// BPM detection (aubio)
// Returns detected BPM, or 0 on error.
float dj_detect_bpm(const char* filepath);

// Beat detection (aubio)
// Writes beat positions (in seconds) into out_beats, up to max_beats.
// Returns the number of beats detected.
int dj_detect_beats(const char* filepath, float* out_beats, int max_beats);

#ifdef __cplusplus
}
#endif

#endif // DJENGINE_H
