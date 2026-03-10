CC = cc
CFLAGS = -fPIC -O2
AUBIO_CFLAGS = -I/opt/homebrew/include
AUBIO_LDFLAGS = -L/opt/homebrew/lib -laubio -lrubberband
FRAMEWORKS = -framework CoreAudio -framework AudioToolbox -framework CoreFoundation -framework CoreMIDI

TARGET = libdjengine.dylib

HEADERS = djengine.h djengine_internal.h filter.h midi.h miniaudio.h

SRCS = miniaudio_impl.c filter.c io_map.c stretch.c lifecycle.c playback.c \
       tempo.c sync.c eq.c djfilter.c automation.c loop.c level.c \
       analysis.c midi.c diag.c
OBJS = $(SRCS:.c=.o)

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) -shared -o $@ $(OBJS) $(AUBIO_LDFLAGS) $(FRAMEWORKS)

%.o: %.c $(HEADERS)
	$(CC) $(CFLAGS) $(AUBIO_CFLAGS) -c -o $@ $<

clean:
	rm -f $(TARGET) $(OBJS)

.PHONY: all clean
