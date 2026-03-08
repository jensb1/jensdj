#ifndef MIDI_H
#define MIDI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint8_t status;   // 0xB0=CC, 0x90=note on, 0x80=note off
    uint8_t data1;    // CC number or note number
    uint8_t data2;    // value 0-127
    uint8_t channel;  // MIDI channel 0-15
} DjMidiMessage;

int dj_midi_init(void);
void dj_midi_shutdown(void);
int dj_midi_get_source_count(void);
const char* dj_midi_get_source_name(int index);
int dj_midi_open_input(int source_index);
void dj_midi_close_input(void);
int dj_midi_poll(DjMidiMessage* out, int max_messages);
int dj_midi_get_dest_count(void);
const char* dj_midi_get_dest_name(int index);
int dj_midi_open_output(int dest_index);
int dj_midi_send(uint8_t status, uint8_t data1, uint8_t data2);
void dj_midi_close_output(void);

#ifdef __cplusplus
}
#endif

#endif // MIDI_H
