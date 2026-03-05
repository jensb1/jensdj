import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "JensDJ",
    identifier: "dev.jensdj.app",
    version: "0.0.1",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/compiled.css": "views/mainview/compiled.css",
      "native/libdjengine.dylib": "../native/libdjengine.dylib",
    },
  },
} satisfies ElectrobunConfig;
