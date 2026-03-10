const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const c_flags = &[_][]const u8{ "-fPIC", "-O2" };

    const lib = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "djengine",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/root.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    // Compile C source files
    lib.addCSourceFile(.{ .file = b.path("miniaudio_impl.c"), .flags = c_flags });
    lib.addCSourceFile(.{ .file = b.path("c_api.c"), .flags = c_flags });

    // Include paths
    lib.addIncludePath(b.path(".")); // For miniaudio.h
    lib.addSystemIncludePath(.{ .cwd_relative = "/opt/homebrew/include" });

    // Library paths
    lib.addLibraryPath(.{ .cwd_relative = "/opt/homebrew/lib" });

    // Link external libraries
    lib.linkSystemLibrary("rubberband");
    lib.linkSystemLibrary("aubio");

    // Link macOS frameworks
    lib.linkFramework("CoreAudio");
    lib.linkFramework("AudioToolbox");
    lib.linkFramework("CoreFoundation");
    lib.linkFramework("CoreMIDI");

    b.installArtifact(lib);

    // Copy dylib to native/ for dev convenience
    const cp = b.addSystemCommand(&.{ "cp", "-f" });
    cp.addArtifactArg(lib);
    cp.addArg("libdjengine.dylib");
    b.default_step.dependOn(&cp.step);
}
