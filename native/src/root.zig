// root.zig — Entry point for the Zig shared library.
// Comptime imports prevent dead-code elimination of exported symbols.

comptime {
    _ = @import("types.zig");
    _ = @import("c.zig");
    _ = @import("filter.zig");
    _ = @import("io_map.zig");
    _ = @import("eq.zig");
    _ = @import("djfilter.zig");
    _ = @import("loop.zig");
    _ = @import("level.zig");
    _ = @import("tempo.zig");
    _ = @import("diag.zig");
    _ = @import("automation.zig");
    _ = @import("lifecycle.zig");
    _ = @import("stretch.zig");
    _ = @import("playback.zig");
    _ = @import("sync.zig");
    _ = @import("beat_grid.zig");
    _ = @import("sync_engine.zig");
    _ = @import("analysis.zig");
    _ = @import("midi.zig");
}

/// Version check — returns 1 to confirm Zig engine is linked.
export fn dj_zig_version() callconv(.c) c_int {
    return 1;
}
