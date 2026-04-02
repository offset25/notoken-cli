#!/usr/bin/env node
/**
 * Bundle mycli into a single CJS file using esbuild.
 * This is Step 1 of the binary build process.
 *
 * Usage: node scripts/build-binary.mjs
 * Output: dist/sea/mycli-bundle.cjs
 */

import esbuild from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist/sea", { recursive: true });

console.log("Bundling with esbuild...");

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/sea/mycli-bundle.cjs",
  sourcemap: false,
  minify: true,
  loader: { ".json": "json" },
  // simple-git shells out to `git` binary — bundle the JS, git must be on PATH
  external: [],
  // Handle import.meta.url in CJS context
  define: {
    "import.meta.url": "_importMetaUrl",
  },
  banner: {
    js: [
      `const _importMetaUrl = require("url").pathToFileURL(__filename).href;`,
      `const _sea_mode = true;`,
    ].join("\n"),
  },
});

console.log("Bundle created: dist/sea/mycli-bundle.cjs");
