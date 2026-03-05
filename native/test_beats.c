/*
 * test_beats.c — Diagnose beat detection accuracy
 *
 * 1. Decode MP3 to PCM, find transients by amplitude threshold
 * 2. Run aubio onset detection, compare positions
 * 3. Run aubio tempo detection, compare positions
 * 4. Print detailed comparison
 */

#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"
#include <aubio/aubio.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

#define SAMPLERATE 44100
#define MAX_TRANSIENTS 500

// 2nd-order Butterworth low-pass filter
typedef struct {
    float x1, x2, y1, y2;
    float b0, b1, b2, a1, a2;
} LPF;

void lpf_init(LPF* f, float cutoff_hz, float sr) {
    float w0 = 2.0f * (float)M_PI * cutoff_hz / sr;
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

float lpf_process(LPF* f, float x) {
    float y = f->b0 * x + f->b1 * f->x1 + f->b2 * f->x2
            - f->a1 * f->y1 - f->a2 * f->y2;
    f->x2 = f->x1; f->x1 = x;
    f->y2 = f->y1; f->y1 = y;
    return y;
}

// Find transients in low-pass filtered PCM (200Hz cutoff isolates kick)
int find_transients(float* pcm, ma_uint64 total_frames, float threshold,
                    float min_interval_sec, float* out_times, int max_out) {
    LPF lp1, lp2;
    lpf_init(&lp1, 200.0f, (float)SAMPLERATE);
    lpf_init(&lp2, 200.0f, (float)SAMPLERATE);

    int count = 0;
    float last_time = -1.0f;
    int in_transient = 0;
    float envelope = 0.0f;
    float attack = 0.005f;
    float release = 0.0005f;

    for (ma_uint64 i = 0; i < total_frames && count < max_out; i++) {
        float filtered = lpf_process(&lp2, lpf_process(&lp1, pcm[i]));
        float sample = fabsf(filtered);

        if (sample > envelope)
            envelope += attack * (sample - envelope);
        else
            envelope += release * (sample - envelope);

        float time = (float)i / (float)SAMPLERATE;

        if (!in_transient && envelope > threshold) {
            if (last_time < 0 || (time - last_time) > min_interval_sec) {
                out_times[count++] = time;
                last_time = time;
            }
            in_transient = 1;
        } else if (in_transient && envelope < threshold * 0.5f) {
            in_transient = 0;
        }
    }
    return count;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        printf("Usage: %s <audio-file>\n", argv[0]);
        return 1;
    }
    const char* filepath = argv[1];

    // --- Decode to PCM ---
    ma_decoder decoder;
    ma_decoder_config dconfig = ma_decoder_config_init(ma_format_f32, 1, SAMPLERATE);
    if (ma_decoder_init_file(filepath, &dconfig, &decoder) != MA_SUCCESS) {
        printf("Failed to decode: %s\n", filepath);
        return 1;
    }

    ma_uint64 total_frames = 0;
    ma_decoder_get_length_in_pcm_frames(&decoder, &total_frames);
    printf("File: %s\n", filepath);
    printf("Total frames: %llu (%.2f seconds)\n\n", total_frames, (float)total_frames / SAMPLERATE);

    float* pcm = malloc(total_frames * sizeof(float));
    ma_uint64 frames_read = 0;
    ma_decoder_read_pcm_frames(&decoder, pcm, total_frames, &frames_read);
    ma_decoder_uninit(&decoder);
    printf("Decoded %llu frames\n\n", frames_read);

    // --- Step 1: Find transients in raw PCM ---
    float transients[MAX_TRANSIENTS];
    int n_transients = find_transients(pcm, frames_read, 0.05f, 0.2f, transients, MAX_TRANSIENTS);
    printf("=== RAW PCM TRANSIENTS (threshold=0.05, min_interval=0.2s) ===\n");
    printf("Found %d transients\n", n_transients);
    for (int i = 0; i < n_transients && i < 20; i++) {
        printf("  Transient %2d: %.4fs", i, transients[i]);
        if (i > 0) printf("  (interval: %.1fms)", (transients[i] - transients[i-1]) * 1000.0f);
        printf("\n");
    }

    // --- Step 2: Aubio onset detection ---
    printf("\n=== AUBIO ONSET DETECTION ===\n");
    {
        uint_t buf_size = 1024;
        uint_t hop_size = 256;  // smaller hop for better timing precision

        aubio_onset_t* onset = new_aubio_onset("default", buf_size, hop_size, SAMPLERATE);
        if (!onset) { printf("Failed to create onset\n"); return 1; }

        // Lower threshold for kick detection
        aubio_onset_set_silence(onset, -40.0f);
        aubio_onset_set_minioi_ms(onset, 200.0f);  // min 200ms between onsets

        fvec_t* input = new_fvec(hop_size);
        fvec_t* output = new_fvec(1);

        float onset_times[MAX_TRANSIENTS];
        int onset_count = 0;
        ma_uint64 pos = 0;

        while (pos < frames_read && onset_count < MAX_TRANSIENTS) {
            uint_t to_copy = hop_size;
            if (pos + to_copy > frames_read) to_copy = (uint_t)(frames_read - pos);

            for (uint_t i = 0; i < to_copy; i++) input->data[i] = pcm[pos + i];
            for (uint_t i = to_copy; i < hop_size; i++) input->data[i] = 0.0f;

            aubio_onset_do(onset, input, output);

            if (output->data[0] != 0.0f) {
                onset_times[onset_count] = aubio_onset_get_last_s(onset);
                onset_count++;
            }
            pos += hop_size;
        }

        printf("Found %d onsets\n", onset_count);
        printf("Delay: %d samples (%.1fms)\n", aubio_onset_get_delay(onset),
               aubio_onset_get_delay_s(onset) * 1000.0f);
        for (int i = 0; i < onset_count && i < 20; i++) {
            printf("  Onset %2d: %.4fs", i, onset_times[i]);
            if (i > 0) printf("  (interval: %.1fms)", (onset_times[i] - onset_times[i-1]) * 1000.0f);
            printf("\n");
        }

        // Compare onset vs transient
        printf("\nOnset vs PCM transient comparison (first 20):\n");
        for (int i = 0; i < onset_count && i < 20 && i < n_transients; i++) {
            float diff = (onset_times[i] - transients[i]) * 1000.0f;
            printf("  %2d: onset=%.4f  pcm=%.4f  diff=%.1fms\n",
                   i, onset_times[i], transients[i], diff);
        }

        del_fvec(input);
        del_fvec(output);
        del_aubio_onset(onset);
    }

    // --- Step 3: Aubio tempo detection ---
    printf("\n=== AUBIO TEMPO DETECTION ===\n");
    {
        uint_t buf_size = 1024;
        uint_t hop_size = 512;

        aubio_tempo_t* tempo = new_aubio_tempo("default", buf_size, hop_size, SAMPLERATE);
        if (!tempo) { printf("Failed to create tempo\n"); return 1; }

        fvec_t* input = new_fvec(hop_size);
        fvec_t* output = new_fvec(1);

        float beat_times[MAX_TRANSIENTS];
        int beat_count = 0;
        ma_uint64 pos = 0;

        while (pos < frames_read && beat_count < MAX_TRANSIENTS) {
            uint_t to_copy = hop_size;
            if (pos + to_copy > frames_read) to_copy = (uint_t)(frames_read - pos);

            for (uint_t i = 0; i < to_copy; i++) input->data[i] = pcm[pos + i];
            for (uint_t i = to_copy; i < hop_size; i++) input->data[i] = 0.0f;

            aubio_tempo_do(tempo, input, output);

            if (output->data[0] != 0.0f) {
                beat_times[beat_count] = aubio_tempo_get_last_s(tempo);
                beat_count++;
            }
            pos += hop_size;
        }

        float bpm = aubio_tempo_get_bpm(tempo);
        float period = aubio_tempo_get_period_s(tempo);
        float confidence = aubio_tempo_get_confidence(tempo);
        uint_t delay = aubio_tempo_get_delay(tempo);

        printf("BPM: %.2f  Period: %.4fs (%.1fms)  Confidence: %.3f  Delay: %u samples (%.1fms)\n",
               bpm, period, period * 1000.0f, confidence, delay, (float)delay / SAMPLERATE * 1000.0f);
        printf("Found %d beats\n", beat_count);
        for (int i = 0; i < beat_count && i < 20; i++) {
            printf("  Beat %2d: %.4fs", i, beat_times[i]);
            if (i > 0) printf("  (interval: %.1fms)", (beat_times[i] - beat_times[i-1]) * 1000.0f);
            printf("\n");
        }

        // Compare tempo beats vs transients
        printf("\nTempo beat vs PCM transient comparison (first 20):\n");
        for (int i = 0; i < beat_count && i < 20; i++) {
            // Find nearest transient
            float min_dist = 99999.0f;
            int nearest = -1;
            for (int j = 0; j < n_transients; j++) {
                float d = fabsf(beat_times[i] - transients[j]);
                if (d < min_dist) { min_dist = d; nearest = j; }
            }
            printf("  Beat %2d: %.4fs → nearest transient %d at %.4fs (diff: %.1fms)\n",
                   i, beat_times[i], nearest, nearest >= 0 ? transients[nearest] : 0.0f, min_dist * 1000.0f);
        }

        del_fvec(input);
        del_fvec(output);
        del_aubio_tempo(tempo);
    }

    // --- Step 4: Test different tempo hop sizes ---
    printf("\n=== TEMPO WITH DIFFERENT HOP SIZES ===\n");
    uint_t hop_sizes[] = {256, 512, 1024};
    for (int h = 0; h < 3; h++) {
        uint_t hop = hop_sizes[h];
        uint_t buf = hop * 2;
        aubio_tempo_t* tempo = new_aubio_tempo("default", buf, hop, SAMPLERATE);
        fvec_t* input = new_fvec(hop);
        fvec_t* output = new_fvec(1);

        float first_beat = -1;
        int beat_count = 0;
        ma_uint64 pos = 0;

        while (pos < frames_read) {
            uint_t to_copy = hop;
            if (pos + to_copy > frames_read) to_copy = (uint_t)(frames_read - pos);
            for (uint_t i = 0; i < to_copy; i++) input->data[i] = pcm[pos + i];
            for (uint_t i = to_copy; i < hop; i++) input->data[i] = 0.0f;

            aubio_tempo_do(tempo, input, output);
            if (output->data[0] != 0.0f) {
                if (first_beat < 0) first_beat = aubio_tempo_get_last_s(tempo);
                beat_count++;
            }
            pos += hop;
        }

        printf("  hop=%u buf=%u: BPM=%.2f period=%.4fs first_beat=%.4fs beats=%d\n",
               hop, buf, aubio_tempo_get_bpm(tempo), aubio_tempo_get_period_s(tempo),
               first_beat, beat_count);

        del_fvec(input);
        del_fvec(output);
        del_aubio_tempo(tempo);
    }

    free(pcm);
    return 0;
}
