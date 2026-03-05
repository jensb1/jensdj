CC = cc
CFLAGS = -shared -fPIC -O2
AUBIO_CFLAGS = -I/opt/homebrew/include
AUBIO_LDFLAGS = -L/opt/homebrew/lib -laubio -lrubberband
FRAMEWORKS = -framework CoreAudio -framework AudioToolbox -framework CoreFoundation

TARGET = libdjengine.dylib

all: $(TARGET)

$(TARGET): djengine.c djengine.h miniaudio.h
	$(CC) $(CFLAGS) -o $@ djengine.c \
		$(AUBIO_CFLAGS) $(AUBIO_LDFLAGS) \
		$(FRAMEWORKS)

clean:
	rm -f $(TARGET)

.PHONY: all clean
