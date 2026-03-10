// midi.zig — CoreMIDI integration (ring buffer, input/output, endpoint enumeration)

const std = @import("std");
const types = @import("types.zig");
const c = @import("c.zig");


const DjMidiGlobal = struct {
    client: u32 = 0,
    input_port: u32 = 0,
    output_port: u32 = 0,
    current_source: u32 = 0,
    current_dest: u32 = 0,
    initialized: bool = false,

    ring: [types.MIDI_RING_SIZE]types.DjMidiMessage = std.mem.zeroes([types.MIDI_RING_SIZE]types.DjMidiMessage),
    write_idx: u32 = 0, // accessed atomically
    read_idx: u32 = 0, // accessed atomically

    source_names: [64][types.MIDI_NAME_BUF]u8 = std.mem.zeroes([64][types.MIDI_NAME_BUF]u8),
    source_count: usize = 0,
    dest_names: [64][types.MIDI_NAME_BUF]u8 = std.mem.zeroes([64][types.MIDI_NAME_BUF]u8),
    dest_count: usize = 0,
};

var g_midi = DjMidiGlobal{};

fn getEndpointName(endpoint: u32, buf: []u8) void {
    var name: ?*const anyopaque = null;
    _ = c.MIDIObjectGetStringProperty(endpoint, c.kMIDIPropertyDisplayName, &name);
    if (name == null) _ = c.MIDIObjectGetStringProperty(endpoint, c.kMIDIPropertyName, &name);
    if (name) |n| {
        _ = c.CFStringGetCString(n, buf.ptr, @intCast(buf.len), c.kCFStringEncodingUTF8);
        c.CFRelease(n);
    } else {
        buf[0] = 0;
    }
}

/// MIDI read callback — called by CoreMIDI on MIDI input thread
fn midiReadProc(pktList: ?*const anyopaque, readProcRefCon: ?*anyopaque, srcConnRefCon: ?*anyopaque) callconv(.c) void {
    _ = readProcRefCon;
    _ = srcConnRefCon;
    // Parse MIDI packets from the raw packet list
    // MIDIPacketList layout: numPackets (u32) + packet[0]
    // MIDIPacket layout: timeStamp (u64) + length (u16) + data[256]
    const list_ptr: [*]const u8 = @ptrCast(pktList orelse return);
    const num_packets = @as(*align(1) const u32, @ptrCast(list_ptr)).*;

    // Packet starts at offset 4 (after numPackets)
    var pkt_ptr = list_ptr + 4;

    for (0..num_packets) |_| {
        // MIDIPacket: timeStamp(8) + length(2) + data[256]
        const pkt_length = @as(*align(1) const u16, @ptrCast(pkt_ptr + 8)).*;
        const pkt_data = pkt_ptr + 10;

        var j: u16 = 0;
        while (j < pkt_length) {
            const status = pkt_data[j];
            if (status < 0x80) { j += 1; continue; }
            const channel = status & 0x0F;
            const msg_type = status & 0xF0;
            const data_bytes: u16 = switch (msg_type) {
                0x80, 0x90, 0xA0, 0xB0, 0xE0 => 2,
                0xC0, 0xD0 => 1,
                else => { j += 1; continue; },
            };
            if (j + 1 + data_bytes > pkt_length) break;

            const d1: u8 = if (data_bytes >= 1) pkt_data[j + 1] else 0;
            const d2: u8 = if (data_bytes >= 2) pkt_data[j + 2] else 0;

            const wi = @atomicLoad(u32, &g_midi.write_idx, .monotonic);
            const next_wi = (wi + 1) % types.MIDI_RING_SIZE;
            const ri = @atomicLoad(u32, &g_midi.read_idx, .acquire);
            if (next_wi != ri) {
                g_midi.ring[wi] = .{ .status = msg_type, .data1 = d1, .data2 = d2, .channel = channel };
                @atomicStore(u32, &g_midi.write_idx, next_wi, .release);
            }
            j += 1 + data_bytes;
        }

        // Advance to next packet: aligned to 4 bytes
        const pkt_total = @as(usize, 10) + pkt_length;
        const aligned = (pkt_total + 3) & ~@as(usize, 3);
        pkt_ptr += aligned;
    }
}

export fn dj_midi_init() callconv(.c) c_int {
    if (g_midi.initialized) return 0;

    const name = c.__CFStringMakeConstantString("JensDJ");
    var status = c.MIDIClientCreate(name, null, null, &g_midi.client);
    if (status != 0) return -1;

    status = c.MIDIInputPortCreate(g_midi.client, name, @ptrCast(&midiReadProc), null, &g_midi.input_port);
    if (status != 0) {
        _ = c.MIDIClientDispose(g_midi.client);
        return -2;
    }

    status = c.MIDIOutputPortCreate(g_midi.client, name, &g_midi.output_port);
    // Non-fatal if output port fails

    @atomicStore(u32, &g_midi.write_idx, @as(u32, 0), .monotonic);
    @atomicStore(u32, &g_midi.read_idx, @as(u32, 0), .monotonic);

    g_midi.source_count = @min(c.MIDIGetNumberOfSources(), 64);
    for (0..g_midi.source_count) |i| {
        const src = c.MIDIGetSource(@intCast(i));
        getEndpointName(src, &g_midi.source_names[i]);
    }

    g_midi.dest_count = @min(c.MIDIGetNumberOfDestinations(), 64);
    for (0..g_midi.dest_count) |i| {
        const dst = c.MIDIGetDestination(@intCast(i));
        getEndpointName(dst, &g_midi.dest_names[i]);
    }

    g_midi.initialized = true;
    return 0;
}

export fn dj_midi_shutdown() callconv(.c) void {
    if (!g_midi.initialized) return;
    dj_midi_close_input();
    dj_midi_close_output();
    if (g_midi.output_port != 0) _ = c.MIDIPortDispose(g_midi.output_port);
    if (g_midi.input_port != 0) _ = c.MIDIPortDispose(g_midi.input_port);
    _ = c.MIDIClientDispose(g_midi.client);
    g_midi.initialized = false;
}

export fn dj_midi_get_source_count() callconv(.c) c_int {
    return @intCast(g_midi.source_count);
}

export fn dj_midi_get_source_name(index: c_int) callconv(.c) [*:0]const u8 {
    if (index < 0 or @as(usize, @intCast(index)) >= g_midi.source_count) return "";
    return @ptrCast(&g_midi.source_names[@intCast(index)]);
}

export fn dj_midi_open_input(source_index: c_int) callconv(.c) c_int {
    if (!g_midi.initialized) return -1;
    if (source_index < 0 or @as(usize, @intCast(source_index)) >= g_midi.source_count) return -2;
    dj_midi_close_input();
    const src = c.MIDIGetSource(@intCast(source_index));
    const status = c.MIDIPortConnectSource(g_midi.input_port, src, null);
    if (status != 0) return -3;
    g_midi.current_source = src;
    return 0;
}

export fn dj_midi_close_input() callconv(.c) void {
    if (g_midi.current_source != 0) {
        _ = c.MIDIPortDisconnectSource(g_midi.input_port, g_midi.current_source);
        g_midi.current_source = 0;
    }
}

export fn dj_midi_poll(out: ?[*]types.DjMidiMessage, max_messages: c_int) callconv(.c) c_int {
    const msgs = out orelse return 0;
    if (max_messages <= 0) return 0;
    var count: usize = 0;
    while (count < @as(usize, @intCast(max_messages))) {
        const ri = @atomicLoad(u32, &g_midi.read_idx, .monotonic);
        const wi = @atomicLoad(u32, &g_midi.write_idx, .acquire);
        if (ri == wi) break;
        msgs[count] = g_midi.ring[ri];
        @atomicStore(u32, &g_midi.read_idx, (ri + 1) % types.MIDI_RING_SIZE, .release);
        count += 1;
    }
    return @intCast(count);
}

export fn dj_midi_get_dest_count() callconv(.c) c_int {
    return @intCast(g_midi.dest_count);
}

export fn dj_midi_get_dest_name(index: c_int) callconv(.c) [*:0]const u8 {
    if (index < 0 or @as(usize, @intCast(index)) >= g_midi.dest_count) return "";
    return @ptrCast(&g_midi.dest_names[@intCast(index)]);
}

export fn dj_midi_open_output(dest_index: c_int) callconv(.c) c_int {
    if (!g_midi.initialized) return -1;
    if (dest_index < 0 or @as(usize, @intCast(dest_index)) >= g_midi.dest_count) return -2;
    dj_midi_close_output();
    g_midi.current_dest = c.MIDIGetDestination(@intCast(dest_index));
    return 0;
}

export fn dj_midi_send(status: u8, data1: u8, data2: u8) callconv(.c) c_int {
    if (!g_midi.initialized or g_midi.current_dest == 0 or g_midi.output_port == 0) return -1;
    // Build a MIDIPacketList on the stack
    var buffer: [128]u8 = std.mem.zeroes([128]u8);
    // numPackets = 1
    @as(*align(1) u32, @ptrCast(&buffer[0])).* = 1;
    // packet[0]: timeStamp = 0 (8 bytes), length = 3 (2 bytes), data
    @as(*align(1) u64, @ptrCast(buffer[4..12])).* = 0; // timeStamp
    @as(*align(1) u16, @ptrCast(buffer[12..14])).* = 3; // length
    buffer[14] = status;
    buffer[15] = data1;
    buffer[16] = data2;
    const result = c.MIDISend(g_midi.output_port, g_midi.current_dest, @ptrCast(&buffer));
    return if (result == 0) 0 else -3;
}

export fn dj_midi_close_output() callconv(.c) void {
    g_midi.current_dest = 0;
}
