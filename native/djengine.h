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

// EQ (3-band: lo, mid, hi — gain 0..2, 1 = unity)
void dj_set_eq(void* sound, float lo, float mid, float hi);
float dj_get_eq_lo(void* sound);
float dj_get_eq_mid(void* sound);
float dj_get_eq_hi(void* sound);

// Level metering (returns RMS 0..1)
float dj_get_level(void* sound);

// Loop control
void dj_set_loop(void* sound, float start_seconds, float end_seconds);
void dj_clear_loop(void* sound);
int dj_is_looping(void* sound);


// Scheduled sync playback
// Schedules target_sound to start playing from target_seconds,
// timed to the exact moment source_sound reaches source_seconds.
// Both sounds MUST be on the same engine. Returns 0 on success.
int dj_schedule_sync_play(void* target_sound, float target_seconds,
                          void* source_sound, float source_seconds);

// Immediate synced start: reads source position in real-time,
// seeks the target to a matching phase or transport position,
// then starts sample-accurately.
// preserve_transport: when non-zero, keep the full elapsed offset from source_beat
// instead of only matching the current bar phase.
int dj_sync_start(void* target_sound, float target_beat,
                   void* source_sound, float source_beat, float bar_duration,
                   int preserve_transport);

// Cancel a previously scheduled start (before it fires)
int dj_cancel_scheduled_start(void* sound);

// Read phase diff between two sounds in samples (both read in same call, no gap)
// Returns the bar-phase difference in seconds. 0.0 = perfect sync.
float dj_get_sync_diff(void* sound1, void* sound2, float beat_ref, float bar_duration);

// Time-stretching (Rubber Band — preserves pitch)
// ratio: 1.0 = original tempo, 1.05 = 5% faster, 0.95 = 5% slower
void dj_set_tempo(void* sound, float ratio);
float dj_get_tempo(void* sound);
void dj_set_original_bpm(void* sound, float bpm);
float dj_get_original_bpm(void* sound);

// DJ filter (single knob: 0.0 = full LP, 0.5 = bypass, 1.0 = full HP)
void dj_set_filter(void* sound, float value);
float dj_get_filter(void* sound);

// Parameter automation (sample-rate interpolation)
// param: 0=filter, 1=volume
// interp: 0=linear, 1=easeIn, 2=easeOut
// duration_seconds: 0 = immediate
void dj_set_automation(void* sound, int param, float start_val, float end_val,
                       float duration_seconds, int interp);
void dj_cancel_automation(void* sound, int param);
// Returns current progress 0..1 (-1 if no automation active for param)
float dj_get_automation_value(void* sound, int param);
int dj_is_automation_active(void* sound, int param);

// Waveform peaks extraction
// Decodes the file and writes num_points peak values (0..1) into out_peaks.
// Returns 0 on success, non-zero on error.
int dj_get_peaks(const char* filepath, float* out_peaks, int num_points);

// 3-band waveform peaks (Rekordbox-style colored waveform)
// Writes 3 * num_points floats: [low0,mid0,hi0, low1,mid1,hi1, ...]
// Low: 0-250Hz (kick/bass), Mid: 250-4000Hz (vocals/synth), High: 4000Hz+ (hats/cymbals)
// Returns 0 on success, non-zero on error.
int dj_get_peaks_3band(const char* filepath, float* out_peaks, int num_points);

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
