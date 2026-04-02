#!/usr/bin/env node
/**
 * Build a Node.js Single Executable Application from the bundle.
 * This is Step 2 of the binary build process.
 *
 * Prerequisites:
 *   - Node.js 20+ (SEA support)
 *   - Run build-binary.mjs first
 *
 * Usage: node scripts/build-sea.mjs
 * Output: dist/sea/mycli (standalone binary)
 */

import { execSync } from "node:child_process";
import { existsSync, copyFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

const BUNDLE = "dist/sea/mycli-bundle.cjs";
const BLOB = "dist/sea/mycli-sea.blob";
const OUTPUT = "dist/sea/mycli";
const SEA_CONFIG = "sea-config.json";

// Check prerequisites
if (!existsSync(BUNDLE)) {
  console.error("Bundle not found. Run: node scripts/build-binary.mjs first");
  process.exit(1);
}

const nodeVersion = parseInt(process.versions.node.split(".")[0]);
if (nodeVersion < 20) {
  console.error(`Node.js 20+ required for SEA. Current: ${process.versions.node}`);
  console.error("The bundle at dist/sea/mycli-bundle.cjs can still be run with: node dist/sea/mycli-bundle.cjs");
  process.exit(1);
}

// Step 1: Write SEA config
console.log("Writing SEA config...");
writeFileSync(SEA_CONFIG, JSON.stringify({
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
}, null, 2));

// Step 2: Generate the blob
console.log("Generating SEA blob...");
execSync(`node --experimental-sea-config ${SEA_CONFIG}`, { stdio: "inherit" });

// Step 3: Copy the node binary
console.log("Copying Node.js binary...");
const nodePath = process.execPath;
copyFileSync(nodePath, OUTPUT);

// Step 4: Remove signature on macOS
if (process.platform === "darwin") {
  console.log("Removing macOS signature...");
  try { execSync(`codesign --remove-signature ${OUTPUT}`, { stdio: "pipe" }); } catch {}
}

// Step 5: Inject the blob
console.log("Injecting SEA blob...");
execSync(
  `npx postject ${OUTPUT} NODE_SEA_BLOB ${BLOB} --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
  { stdio: "inherit" }
);

// Step 6: Re-sign on macOS
if (process.platform === "darwin") {
  console.log("Re-signing binary...");
  try { execSync(`codesign --sign - ${OUTPUT}`, { stdio: "pipe" }); } catch {}
}

// Step 7: Make executable
chmodSync(OUTPUT, 0o755);

const stat = execSync(`ls -lh ${OUTPUT}`, { encoding: "utf-8" }).trim();
console.log(`\nBinary created: ${stat}`);
console.log(`\nTest it: ./${OUTPUT} --help`);
