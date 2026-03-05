#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

#define SR 44100
#define MAX_T 2000

typedef struct { float x1,x2,y1,y2,b0,b1,b2,a1,a2; } LPF;
void lpf_init(LPF* f, float fc, float sr) {
    float w=2*M_PI*fc/sr, c=cosf(w), s=sinf(w), a=s/(2*0.7071f), a0=1+a;
    f->b0=((1-c)/2)/a0; f->b1=(1-c)/a0; f->b2=f->b0;
    f->a1=(-2*c)/a0; f->a2=(1-a)/a0; f->x1=f->x2=f->y1=f->y2=0;
}
float lpf_p(LPF* f, float x) {
    float y=f->b0*x+f->b1*f->x1+f->b2*f->x2-f->a1*f->y1-f->a2*f->y2;
    f->x2=f->x1; f->x1=x; f->y2=f->y1; f->y1=y; return y;
}

int find_t(const float* pcm, ma_uint64 n, float* out, int max) {
    LPF l1,l2; lpf_init(&l1,200,SR); lpf_init(&l2,200,SR);
    int count=0; float last=-1, env=0;
    for (ma_uint64 i=0; i<n && count<max; i++) {
        float s=fabsf(lpf_p(&l2, lpf_p(&l1, pcm[i])));
        env += (s>env?0.005f:0.0005f)*(s-env);
        float t=(float)i/SR;
        if (env>0.02f && (last<0||t-last>0.2f)) {
            out[count++]=t; last=t;
            // skip rest of transient
            while (i<n && env>0.01f) {
                i++; s=fabsf(lpf_p(&l2,lpf_p(&l1,pcm[i<n?i:n-1])));
                env+=0.0005f*(s-env);
            }
        }
    }
    return count;
}

int main(int argc, char** argv) {
    if (argc<2) return 1;
    ma_decoder d; ma_decoder_config dc=ma_decoder_config_init(ma_format_f32,1,SR);
    if (ma_decoder_init_file(argv[1],&dc,&d)!=MA_SUCCESS) return 1;
    ma_uint64 n=0; ma_decoder_get_length_in_pcm_frames(&d,&n);
    float* pcm=malloc(n*sizeof(float)); ma_uint64 nr=0;
    ma_decoder_read_pcm_frames(&d,pcm,n,&nr); ma_decoder_uninit(&d);

    float trans[MAX_T]; int nt=find_t(pcm,nr,trans,MAX_T);
    free(pcm);
    printf("Found %d transients\n", nt);

    // Show intervals at different points
    printf("\nIntervals at start (0-10):\n");
    for (int i=1; i<nt && i<=10; i++)
        printf("  %d: %.4fms\n", i, (trans[i]-trans[i-1])*1000);

    printf("\nIntervals at ~60s:\n");
    for (int i=0; i<nt; i++) {
        if (trans[i]>=60 && trans[i]<65) {
            if (i>0) printf("  t=%.2fs: %.4fms\n", trans[i], (trans[i]-trans[i-1])*1000);
        }
    }

    printf("\nIntervals at ~180s:\n");
    for (int i=0; i<nt; i++) {
        if (trans[i]>=180 && trans[i]<185) {
            if (i>0) printf("  t=%.2fs: %.4fms\n", trans[i], (trans[i]-trans[i-1])*1000);
        }
    }

    printf("\nIntervals at ~360s:\n");
    for (int i=0; i<nt; i++) {
        if (trans[i]>=360 && trans[i]<365) {
            if (i>0) printf("  t=%.2fs: %.4fms\n", trans[i], (trans[i]-trans[i-1])*1000);
        }
    }

    printf("\nIntervals at ~500s:\n");
    for (int i=0; i<nt; i++) {
        if (trans[i]>=500 && trans[i]<505) {
            if (i>0) printf("  t=%.2fs: %.4fms\n", trans[i], (trans[i]-trans[i-1])*1000);
        }
    }

    // Compute best-fit BPM using linear regression on transient positions
    // Expected: trans[i] = phase + i * interval
    // Minimize sum of (trans[i] - phase - i*interval)^2
    // This is a simple linear regression: y=a+bx where y=trans[i], x=i
    double sx=0, sy=0, sxy=0, sx2=0;
    for (int i=0; i<nt; i++) {
        sx += i; sy += trans[i]; sxy += (double)i*trans[i]; sx2 += (double)i*i;
    }
    double n_d = nt;
    double interval = (n_d*sxy - sx*sy) / (n_d*sx2 - sx*sx);
    double phase = (sy - interval*sx) / n_d;
    double bpm = 60.0 / interval;

    printf("\n=== Linear regression BPM ===\n");
    printf("Interval: %.6fms\n", interval*1000);
    printf("BPM: %.6f\n", bpm);
    printf("Phase: %.6fs\n", phase);

    // Show drift: compare regression grid vs actual transients
    printf("\nDrift (regression grid vs actual transients):\n");
    for (int check=0; check<nt; check += nt/10) {
        double expected = phase + check * interval;
        double diff = (trans[check] - expected) * 1000;
        printf("  trans[%d] at t=%.1fs: expected=%.4f actual=%.4f drift=%.2fms\n",
               check, trans[check], expected, trans[check], diff);
    }

    // Compare median interval vs regression
    float intervals[MAX_T]; int ni=0;
    for (int i=1; i<nt; i++) {
        float iv=trans[i]-trans[i-1];
        if (iv>0.3f && iv<1.0f) intervals[ni++]=iv;
    }
    // sort
    for (int i=0; i<ni-1; i++) for (int j=i+1; j<ni; j++)
        if (intervals[j]<intervals[i]) { float t=intervals[i]; intervals[i]=intervals[j]; intervals[j]=t; }
    printf("\nMedian interval: %.6fms (BPM: %.6f)\n", intervals[ni/2]*1000, 60.0/intervals[ni/2]);
    printf("Regression interval: %.6fms (BPM: %.6f)\n", interval*1000, bpm);
    printf("Difference: %.6fms per beat\n", (intervals[ni/2]-interval)*1000);
    printf("Cumulative drift over 1000 beats: %.1fms\n", (intervals[ni/2]-interval)*1000*1000);

    return 0;
}
