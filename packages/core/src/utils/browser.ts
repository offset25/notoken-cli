/**
 * Browser Manager.
 *
 * Detects, installs, and launches browser automation engines.
 *
 * Priority:
 *   1. Patchright (patched Playwright — anti-detection)
 *   2. Playwright
 *   3. Docker (browserless/chromium container)
 *   4. System browser (xdg-open / open / start)
 *
 * Usage:
 *   notoken browse <url>
 *   notoken browse install
 *   notoken browse status
 *   "open google.com"
 *   "take screenshot of example.com"
 *   "browse to localhost:3000"
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { USER_HOME } from "./paths.js";
import { platform } from "node:os";

const SCREENSHOTS_DIR = resolve(USER_HOME, "screenshots");

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

// ─── Types ─────────────────────────────────────────────────────────────────

export type BrowserEngine = "patchright" | "playwright" | "docker" | "system";

export interface BrowserStatus {
  engine: BrowserEngine;
  available: boolean;
  version?: string;
  browsersInstalled?: boolean;
  dockerImage?: string;
}

export interface BrowseOptions {
  url: string;
  headless?: boolean;
  screenshot?: boolean;
  screenshotPath?: string;
  waitFor?: number;
  userAgent?: string;
  viewport?: { width: number; height: number };
}

export interface BrowseResult {
  engine: BrowserEngine;
  url: string;
  title?: string;
  screenshotPath?: string;
  error?: string;
}

// ─── Detection ─────────────────────────────────────────────────────────────

function tryExec(cmd: string, timeout = 5000): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout }).trim() || null;
  } catch {
    return null;
  }
}

function hasNpmPackage(name: string): boolean {
  // Fast check: try to resolve the module directly
  const resolved = tryExec(`node -e "try{require.resolve('${name}');console.log('ok')}catch{}" 2>/dev/null`, 3000);
  if (resolved === "ok") return true;
  // Check global bin
  if (tryExec(`which ${name} 2>/dev/null`, 2000)) return true;
  return false;
}

export function detectBrowserEngines(): BrowserStatus[] {
  const engines: BrowserStatus[] = [];

  // 1. Patchright
  const patchrightInstalled = hasNpmPackage("patchright");
  engines.push({
    engine: "patchright",
    available: patchrightInstalled,
    version: patchrightInstalled ? (tryExec("npx patchright --version 2>/dev/null", 3000) ?? "installed") : undefined,
    browsersInstalled: patchrightInstalled ? checkBrowserBinaries("patchright") : false,
  });

  // 2. Playwright
  const playwrightInstalled = hasNpmPackage("playwright");
  engines.push({
    engine: "playwright",
    available: playwrightInstalled,
    version: playwrightInstalled ? (tryExec("npx playwright --version 2>/dev/null", 3000) ?? "installed") : undefined,
    browsersInstalled: playwrightInstalled ? checkBrowserBinaries("playwright") : false,
  });

  // 3. Docker (browserless)
  const dockerAvailable = !!tryExec("docker --version");
  let dockerImage: string | undefined;
  if (dockerAvailable) {
    const images = tryExec("docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null");
    if (images) {
      const browserless = images.split("\n").find(i => i.includes("browserless") || i.includes("chromium") || i.includes("chrome"));
      dockerImage = browserless;
    }
  }
  engines.push({
    engine: "docker",
    available: dockerAvailable,
    version: dockerAvailable ? tryExec("docker --version")?.replace("Docker version ", "") ?? undefined : undefined,
    dockerImage,
  });

  // 4. System browser (always available)
  engines.push({
    engine: "system",
    available: true,
    version: getSystemBrowserName(),
  });

  return engines;
}

function checkBrowserBinaries(engine: "patchright" | "playwright"): boolean {
  // Check if chromium is installed for the engine
  const check = tryExec(`npx ${engine} install --dry-run chromium 2>&1`);
  if (check?.includes("already installed") || check?.includes("is already")) return true;
  // Fallback: try to find the browser cache
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cacheDir = engine === "patchright"
    ? resolve(home, ".cache", "patchright")
    : resolve(home, ".cache", "ms-playwright");
  return existsSync(cacheDir);
}

function getSystemBrowserName(): string {
  const os = platform();
  if (os === "darwin") return "macOS default (open)";
  if (os === "win32") return "Windows default (start)";
  // Check for common Linux browsers
  for (const browser of ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium", "firefox"]) {
    if (tryExec(`which ${browser}`)) return browser;
  }
  return "xdg-open";
}

/**
 * Get the best available engine.
 */
export function getBestEngine(): BrowserStatus | null {
  const engines = detectBrowserEngines();
  // Prefer patchright > playwright > docker (only with image) > system
  const patchright = engines.find(e => e.engine === "patchright" && e.available && e.browsersInstalled);
  if (patchright) return patchright;

  const playwright = engines.find(e => e.engine === "playwright" && e.available && e.browsersInstalled);
  if (playwright) return playwright;

  // Patchright/playwright installed but no browsers — still usable (will auto-download)
  const patchrightNoBrowser = engines.find(e => e.engine === "patchright" && e.available);
  if (patchrightNoBrowser) return patchrightNoBrowser;

  const playwrightNoBrowser = engines.find(e => e.engine === "playwright" && e.available);
  if (playwrightNoBrowser) return playwrightNoBrowser;

  const docker = engines.find(e => e.engine === "docker" && e.available && e.dockerImage);
  if (docker) return docker;

  return engines.find(e => e.engine === "system") ?? null;
}

// ─── Installation ──────────────────────────────────────────────────────────

export interface InstallResult {
  success: boolean;
  engine: BrowserEngine;
  message: string;
}

export async function installBrowserEngine(engine?: BrowserEngine): Promise<InstallResult> {
  const target = engine ?? "patchright";

  if (target === "patchright" || target === "playwright") {
    try {
      console.log(`${c.dim}Installing ${target}...${c.reset}`);
      execSync(`npm install -g ${target}`, { stdio: "inherit", timeout: 120000 });
      console.log(`${c.dim}Installing ${target} browsers (chromium)...${c.reset}`);
      execSync(`npx ${target} install chromium`, { stdio: "inherit", timeout: 300000 });
      return { success: true, engine: target, message: `${target} + chromium installed successfully` };
    } catch (err) {
      return { success: false, engine: target, message: `Failed to install ${target}: ${err instanceof Error ? err.message : err}` };
    }
  }

  if (target === "docker") {
    const dockerAvailable = !!tryExec("docker --version");
    if (!dockerAvailable) {
      return { success: false, engine: "docker", message: "Docker is not installed. Install Docker first." };
    }
    try {
      console.log(`${c.dim}Pulling browserless/chromium image...${c.reset}`);
      execSync("docker pull ghcr.io/browserless/chromium", { stdio: "inherit", timeout: 300000 });
      return { success: true, engine: "docker", message: "browserless/chromium image pulled" };
    } catch (err) {
      return { success: false, engine: "docker", message: `Failed to pull image: ${err instanceof Error ? err.message : err}` };
    }
  }

  return { success: true, engine: "system", message: "System browser is always available" };
}

// ─── Browse ────────────────────────────────────────────────────────────────

/**
 * Open a URL using the best available engine.
 */
export async function browse(opts: BrowseOptions): Promise<BrowseResult> {
  const url = normalizeUrl(opts.url);
  const engine = getBestEngine();

  if (!engine) {
    return { engine: "system", url, error: "No browser engine available" };
  }

  // For system browser or non-headless without screenshot, just open
  if (engine.engine === "system" && !opts.screenshot) {
    return openSystemBrowser(url);
  }

  // For automation engines
  if (engine.engine === "patchright" || engine.engine === "playwright") {
    return browseWithPlaywright(engine.engine, url, opts);
  }

  if (engine.engine === "docker") {
    return browseWithDocker(url, opts);
  }

  return openSystemBrowser(url);
}

export function normalizeUrl(url: string): string {
  // Add https:// if no protocol
  if (!/^https?:\/\//i.test(url) && !url.startsWith("file://")) {
    // If it looks like localhost, use http
    if (url.startsWith("localhost") || url.startsWith("127.0.0.1") || url.startsWith("0.0.0.0")) {
      return `http://${url}`;
    }
    return `https://${url}`;
  }
  return url;
}

function openSystemBrowser(url: string): BrowseResult {
  try {
    const os = platform();
    if (os === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (os === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore", shell: "cmd.exe" });
    } else {
      // WSL check
      const isWSL = tryExec("grep -qi microsoft /proc/version && echo wsl");
      if (isWSL) {
        execSync(`cmd.exe /c start "" "${url}"`, { stdio: "ignore" });
      } else {
        execSync(`xdg-open "${url}"`, { stdio: "ignore" });
      }
    }
    return { engine: "system", url, title: "Opened in system browser" };
  } catch (err) {
    return { engine: "system", url, error: `Failed to open: ${err instanceof Error ? err.message : err}` };
  }
}

async function browseWithPlaywright(
  engine: "patchright" | "playwright",
  url: string,
  opts: BrowseOptions,
): Promise<BrowseResult> {
  // Generate a script and run it via node
  const headless = opts.headless ?? !opts.screenshot;
  const viewport = opts.viewport ?? { width: 1280, height: 720 };
  const waitFor = opts.waitFor ?? 2000;

  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const screenshotPath = opts.screenshotPath ?? opts.screenshot
    ? resolve(SCREENSHOTS_DIR, `screenshot-${Date.now()}.png`)
    : undefined;

  const script = `
const { chromium } = require("${engine}");
(async () => {
  const browser = await chromium.launch({ headless: ${headless} });
  const context = await browser.newContext({
    viewport: { width: ${viewport.width}, height: ${viewport.height} },
    ${opts.userAgent ? `userAgent: "${opts.userAgent}",` : ""}
  });
  const page = await context.newPage();
  await page.goto("${url}", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(${waitFor});
  const title = await page.title();
  ${screenshotPath ? `await page.screenshot({ path: "${screenshotPath}", fullPage: true });` : ""}
  ${!headless && !opts.screenshot ? `
  // Keep browser open for interactive use
  console.log(JSON.stringify({ title, status: "open" }));
  // Wait for user to close
  await new Promise(() => {});
  ` : `
  console.log(JSON.stringify({ title, status: "done" }));
  await browser.close();
  `}
})().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
`;

  const tmpScript = resolve(USER_HOME, ".browse-script.cjs");
  writeFileSync(tmpScript, script);

  return new Promise<BrowseResult>((res) => {
    const child = spawn("node", [tmpScript], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: opts.screenshot ? 60000 : 0,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    // For interactive (non-headless, no screenshot), resolve immediately
    if (!headless && !opts.screenshot) {
      setTimeout(() => {
        res({ engine, url, title: "Browser opened interactively", screenshotPath: undefined });
      }, 3000);
      return;
    }

    child.on("close", () => {
      try {
        const result = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
        if (result.error) {
          res({ engine, url, error: result.error });
        } else {
          res({ engine, url, title: result.title, screenshotPath });
        }
      } catch {
        res({ engine, url, error: stderr || "Unknown error" });
      }
    });
  });
}

async function browseWithDocker(url: string, opts: BrowseOptions): Promise<BrowseResult> {
  const screenshotPath = opts.screenshot
    ? resolve(SCREENSHOTS_DIR, `screenshot-${Date.now()}.png`)
    : undefined;

  try {
    // Start browserless container if not running
    const running = tryExec("docker ps --format '{{.Image}}' 2>/dev/null");
    if (!running?.includes("browserless")) {
      console.log(`${c.dim}Starting browserless container...${c.reset}`);
      execSync("docker run -d --rm -p 3100:3000 --name notoken-browser ghcr.io/browserless/chromium", {
        stdio: "ignore",
        timeout: 30000,
      });
      // Wait for it to be ready
      execSync("sleep 2");
    }

    if (opts.screenshot && screenshotPath) {
      mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      // Use browserless screenshot API
      execSync(`curl -sf -o "${screenshotPath}" "http://localhost:3100/screenshot?url=${encodeURIComponent(url)}"`, {
        timeout: 30000,
      });
      return { engine: "docker", url, title: "Screenshot via Docker", screenshotPath };
    }

    // Just open — use browserless content API to get title
    const content = tryExec(`curl -sf "http://localhost:3100/content?url=${encodeURIComponent(url)}" 2>/dev/null`);
    const titleMatch = content?.match(/<title>([^<]+)<\/title>/i);
    return { engine: "docker", url, title: titleMatch?.[1] ?? "Page loaded via Docker" };
  } catch (err) {
    return { engine: "docker", url, error: `Docker browse failed: ${err instanceof Error ? err.message : err}` };
  }
}

// ─── Formatting ────────────────────────────────────────────────────────────

export function formatBrowserStatus(engines: BrowserStatus[]): string {
  const lines: string[] = [];
  lines.push(`${c.bold}Browser Engines${c.reset}\n`);

  for (const e of engines) {
    const icon = e.available
      ? (e.engine === "system" ? `${c.green}⬤${c.reset}` :
         e.browsersInstalled !== false ? `${c.green}⬤${c.reset}` : `${c.yellow}⬤${c.reset}`)
      : `${c.dim}○${c.reset}`;

    const status = e.available
      ? (e.browsersInstalled === false ? `${c.yellow}installed (no browsers)${c.reset}` : `${c.green}ready${c.reset}`)
      : `${c.dim}not installed${c.reset}`;

    const ver = e.version ? ` ${c.dim}${e.version}${c.reset}` : "";
    const docker = e.dockerImage ? ` ${c.dim}image: ${e.dockerImage}${c.reset}` : "";
    const pref = e === getBestEngine() ? ` ${c.cyan}← active${c.reset}` : "";

    lines.push(`  ${icon} ${c.bold}${e.engine}${c.reset} — ${status}${ver}${docker}${pref}`);
  }

  const best = getBestEngine();
  lines.push("");
  lines.push(`  ${c.dim}Active engine: ${best?.engine ?? "none"}${c.reset}`);
  lines.push(`  ${c.dim}Screenshots: ${SCREENSHOTS_DIR}${c.reset}`);

  return lines.join("\n");
}

// ─── Stop Docker browser ───────────────────────────────────────────────────

export function stopDockerBrowser(): string {
  try {
    execSync("docker stop notoken-browser 2>/dev/null", { stdio: "ignore", timeout: 10000 });
    return `${c.green}✓${c.reset} Docker browser stopped.`;
  } catch {
    return `${c.dim}No Docker browser running.${c.reset}`;
  }
}
