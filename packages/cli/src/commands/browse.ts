/**
 * notoken browse
 *
 * Browser automation — open URLs, take screenshots, interactive browsing.
 *
 * Usage:
 *   notoken browse <url>              Open URL in best available engine
 *   notoken browse <url> --screenshot Take a screenshot
 *   notoken browse <url> --headless   Run headless (no window)
 *   notoken browse status             Show available engines
 *   notoken browse install [engine]   Install a browser engine
 *   notoken browse stop               Stop Docker browser container
 */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  detectBrowserEngines, getBestEngine, installBrowserEngine,
  browse, formatBrowserStatus, stopDockerBrowser,
  type BrowserEngine,
} from "notoken-core";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

export async function runBrowse(args: string[], flags: Set<string>): Promise<void> {
  const sub = args[0];

  // notoken browse status
  if (sub === "status") {
    const engines = detectBrowserEngines();
    console.log(formatBrowserStatus(engines));
    return;
  }

  // notoken browse install [engine]
  if (sub === "install") {
    const engine = (args[1] as BrowserEngine) ?? undefined;
    if (engine && !["patchright", "playwright", "docker"].includes(engine)) {
      console.log(`${c.red}Unknown engine: ${engine}${c.reset}`);
      console.log(`Available: patchright, playwright, docker`);
      return;
    }

    // If no engine specified, check what's available and suggest
    if (!engine) {
      const engines = detectBrowserEngines();
      const best = getBestEngine();
      if (best && best.engine !== "system") {
        console.log(`${c.green}✓${c.reset} ${best.engine} is already available.`);
        if (best.browsersInstalled === false) {
          console.log(`${c.yellow}→${c.reset} Browsers not installed. Installing chromium...`);
          const result = await installBrowserEngine(best.engine as BrowserEngine);
          console.log(result.success ? `${c.green}✓${c.reset} ${result.message}` : `${c.red}✗${c.reset} ${result.message}`);
        }
        return;
      }
      console.log(`${c.dim}No browser engine installed. Installing patchright (recommended)...${c.reset}`);
      const result = await installBrowserEngine("patchright");
      console.log(result.success ? `${c.green}✓${c.reset} ${result.message}` : `${c.red}✗${c.reset} ${result.message}`);

      if (!result.success) {
        console.log(`\n${c.dim}Trying playwright as fallback...${c.reset}`);
        const fallback = await installBrowserEngine("playwright");
        console.log(fallback.success ? `${c.green}✓${c.reset} ${fallback.message}` : `${c.red}✗${c.reset} ${fallback.message}`);
      }
      return;
    }

    const result = await installBrowserEngine(engine);
    console.log(result.success ? `${c.green}✓${c.reset} ${result.message}` : `${c.red}✗${c.reset} ${result.message}`);
    return;
  }

  // notoken browse stop
  if (sub === "stop") {
    console.log(stopDockerBrowser());
    return;
  }

  // notoken browse (no args) — show help + status
  if (!sub) {
    console.log(`
${c.bold}${c.cyan}  notoken browse${c.reset}

${c.bold}Usage:${c.reset}
  notoken browse <url>                Open URL in browser
  notoken browse <url> --screenshot   Take a full-page screenshot
  notoken browse <url> --headless     Run in headless mode
  notoken browse status               Show available browser engines
  notoken browse install [engine]     Install engine (patchright, playwright, docker)
  notoken browse stop                 Stop Docker browser container

${c.bold}Engine priority:${c.reset} patchright > playwright > docker > system browser
`);
    const engines = detectBrowserEngines();
    console.log(formatBrowserStatus(engines));
    return;
  }

  // notoken browse <url>
  const url = sub;
  const headless = flags.has("--headless");
  const screenshot = flags.has("--screenshot") || flags.has("--ss");

  const best = getBestEngine();
  if (!best) {
    console.log(`${c.red}No browser engine available.${c.reset}`);
    console.log(`Run: notoken browse install`);
    return;
  }

  // If only system browser and screenshot requested, need a real engine
  if (best.engine === "system" && screenshot) {
    console.log(`${c.yellow}Screenshot requires patchright, playwright, or docker.${c.reset}`);
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(`${c.cyan}Install patchright? (y/n) ${c.reset}`);
    rl.close();
    if (answer.toLowerCase() === "y") {
      const result = await installBrowserEngine("patchright");
      if (!result.success) {
        console.log(`${c.red}✗${c.reset} ${result.message}`);
        return;
      }
    } else {
      return;
    }
  }

  console.log(`${c.dim}Opening ${url} via ${best.engine}...${c.reset}`);
  const result = await browse({ url, headless, screenshot });

  if (result.error) {
    console.log(`${c.red}✗${c.reset} ${result.error}`);
    return;
  }

  console.log(`${c.green}✓${c.reset} ${result.title ?? "Page loaded"} ${c.dim}(${result.engine})${c.reset}`);
  if (result.screenshotPath) {
    console.log(`${c.cyan}📸${c.reset} Screenshot: ${result.screenshotPath}`);
  }
}
