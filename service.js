#!/usr/bin/env node

/**
 * NoToken launcher — run the CLI from the repo root.
 *
 * Usage:
 *   node service.js                    — interactive mode
 *   node service.js "restart nginx"    — one-shot command
 *   node service.js status             — system status
 */

import("./packages/cli/dist/index.js").catch(err => {
  console.error("Failed to start NoToken:", err.message);
  console.error("Try: npm run build");
  process.exit(1);
});
