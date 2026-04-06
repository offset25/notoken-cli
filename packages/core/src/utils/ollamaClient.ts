/**
 * Ollama API client that transparently bridges Windows ↔ WSL.
 *
 * Tries direct HTTP first, then falls back to `wsl curl` when the API
 * is only reachable from inside WSL.  Caches the working method so
 * subsequent calls skip the probe.
 */

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryExecAsync } from "./asyncExec.js";

/* ── types ── */

export interface OllamaMethod {
  type: "api" | "wsl";
  url?: string;
  empty?: boolean;
}

export interface OllamaApiResult {
  ok: boolean;
  status?: number;
  data: unknown;
  via: string;
}

export interface OllamaModelEntry {
  name: string;
  size: string;
  family: string;
  params?: string;
  via: string;
}

export interface OllamaStatus {
  windowsRunning: boolean;
  wslRunning: boolean;
  wslInstalled?: boolean;
  windowsModels: number;
  wslModels: number;
  models: Array<{ name: string; size: string; family: string; via: string }>;
  via: string;
}

/* ── cached transport method ── */

let ollamaMethod: string | null = null;

/**
 * Discover the best way to talk to Ollama.
 *
 * Returns an {@link OllamaMethod} descriptor or `null` when Ollama is
 * unreachable.  The result is cached until the method stops responding.
 */
export async function findOllamaApi(): Promise<OllamaMethod | null> {
  // Check cached "api:<url>" method
  if (ollamaMethod?.startsWith("api:")) {
    const url = ollamaMethod.slice(4);
    try {
      const r = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = (await r.json()) as { models?: unknown[] };
      if (r.ok && (data.models?.length ?? 0) > 0) {
        return { type: "api", url };
      }
    } catch {
      /* stale cache */
    }
    ollamaMethod = null;
  }

  // Check cached "wsl" method
  if (ollamaMethod === "wsl") {
    const out = await tryExecAsync(
      "wsl curl -sf http://127.0.0.1:11434/api/tags 2>/dev/null",
    );
    if (out) {
      try {
        const d = JSON.parse(out) as { models?: unknown[] };
        if ((d.models?.length ?? 0) > 0) return { type: "wsl" };
      } catch {
        /* ignore */
      }
    }
    ollamaMethod = null;
  }

  // Probe direct API — only accept hosts that actually have models
  for (const host of [
    "http://127.0.0.1:11434",
    "http://localhost:11434",
  ]) {
    try {
      const r = await fetch(`${host}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = (await r.json()) as { models?: unknown[] };
      if (r.ok && (data.models?.length ?? 0) > 0) {
        ollamaMethod = `api:${host}`;
        return { type: "api", url: host };
      }
    } catch {
      /* next */
    }
  }

  // Probe WSL Ollama (may have models even when Windows is empty)
  const wslOut = await tryExecAsync(
    "wsl curl -sf http://127.0.0.1:11434/api/tags 2>/dev/null",
    10000,
  );
  if (wslOut) {
    const jsonStart = wslOut.indexOf("{");
    if (jsonStart >= 0) {
      try {
        const d = JSON.parse(wslOut.substring(jsonStart)) as {
          models?: unknown[];
        };
        if ((d.models?.length ?? 0) > 0) {
          ollamaMethod = "wsl";
          return { type: "wsl" };
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Windows Ollama running but empty — still return it for status display
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      ollamaMethod = "api:http://127.0.0.1:11434";
      return { type: "api", url: "http://127.0.0.1:11434", empty: true };
    }
  } catch {
    /* ignore */
  }

  return null;
}

/**
 * Call an Ollama REST endpoint, routing through direct HTTP or WSL curl
 * depending on what {@link findOllamaApi} discovered.
 */
export async function ollamaApiCall(
  endpoint: string,
  body?: Record<string, unknown> | null,
): Promise<OllamaApiResult | null> {
  const method = await findOllamaApi();
  if (!method) return null;

  if (method.type === "api") {
    const opts: RequestInit & { signal: AbortSignal } = {
      signal: AbortSignal.timeout(120000),
    };
    if (body) {
      opts.method = "POST";
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${method.url}${endpoint}`, opts);
    return {
      ok: r.ok,
      status: r.status,
      data: await r.json(),
      via: "api",
    };
  }

  // WSL bridge — use wsl curl
  if (method.type === "wsl") {
    let cmd: string;
    if (body) {
      // Write body to a temp file to avoid shell-escaping pain
      const tmpFile = join(tmpdir(), `ollama-${Date.now()}.json`);
      writeFileSync(tmpFile, JSON.stringify(body));
      cmd = `wsl curl -sf -X POST -H "Content-Type: application/json" -d @${tmpFile} http://127.0.0.1:11434${endpoint} 2>/dev/null`;
    } else {
      cmd = `wsl curl -sf http://127.0.0.1:11434${endpoint} 2>/dev/null`;
    }

    const out = await tryExecAsync(cmd, 120000);
    if (!out) return null;

    // Extract JSON (output may have UNC-path warnings before it)
    const jsonStart = out.indexOf("{");
    if (jsonStart >= 0) {
      try {
        return {
          ok: true,
          data: JSON.parse(out.substring(jsonStart)),
          via: "wsl",
        };
      } catch {
        /* fall through */
      }
    }
    return { ok: true, data: out, via: "wsl" };
  }

  return null;
}

/**
 * Fetch the list of locally-available Ollama models from the best
 * reachable source.
 */
export async function getOllamaModels(): Promise<OllamaModelEntry[]> {
  const result = await ollamaApiCall("/api/tags");
  if (result?.ok && result.data) {
    const data = result.data as {
      models?: Array<{
        name: string;
        size?: number;
        details?: { family?: string; parameter_size?: string };
      }>;
    };
    if (data.models) {
      return data.models.map((m) => ({
        name: m.name,
        size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : "",
        family: m.details?.family || "",
        params: m.details?.parameter_size || "",
        via: result.via,
      }));
    }
  }
  return [];
}

/**
 * Comprehensive Ollama status: checks both Windows and WSL, merges model
 * lists, and reports which transport is in use.
 */
export async function getOllamaStatus(): Promise<OllamaStatus> {
  const result: OllamaStatus = {
    windowsRunning: false,
    wslRunning: false,
    windowsModels: 0,
    wslModels: 0,
    models: [],
    via: "none",
  };

  // Windows Ollama
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      result.windowsRunning = true;
      const data = (await r.json()) as {
        models?: Array<{
          name: string;
          size?: number;
          details?: { family?: string };
        }>;
      };
      result.windowsModels = data.models?.length || 0;
      if (result.windowsModels > 0) {
        result.models = data.models!.map((m) => ({
          name: m.name,
          size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : "",
          family: m.details?.family || "",
          via: "Windows",
        }));
        result.via = "Windows";
      }
    }
  } catch {
    /* not running */
  }

  // WSL Ollama
  const wslCheck = await tryExecAsync("wsl ollama --version 2>/dev/null");
  if (wslCheck) result.wslInstalled = true;

  const wslTags = await tryExecAsync(
    "wsl curl -sf http://127.0.0.1:11434/api/tags 2>/dev/null",
    10000,
  );
  if (wslTags) {
    const jsonStart = wslTags.indexOf("{");
    if (jsonStart >= 0) {
      try {
        const data = JSON.parse(wslTags.substring(jsonStart)) as {
          models?: Array<{
            name: string;
            size?: number;
            details?: { family?: string };
          }>;
        };
        result.wslRunning = true;
        result.wslModels = data.models?.length || 0;
        if (result.wslModels > 0 && result.models.length === 0) {
          result.models = data.models!.map((m) => ({
            name: m.name,
            size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : "",
            family: m.details?.family || "",
            via: "WSL",
          }));
          result.via = "WSL";
        }
      } catch {
        /* ignore */
      }
    }
  }

  return result;
}

/* ── Installation check ── */

/**
 * Synchronous check: is Ollama installed on this system?
 * Works on Windows, WSL, and Linux.
 */
export function isOllamaInstalled(): boolean {
  try {
    execSync("command -v ollama 2>/dev/null || where ollama 2>nul", { timeout: 2000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/* ── Version detection & upgrade check ── */

export interface OllamaVersionInfo {
  windows: { installed: boolean; version: string | null; path: string | null };
  wsl: { installed: boolean; version: string | null; path: string | null };
  latest: string | null;
  windowsOutdated: boolean;
  wslOutdated: boolean;
  upgradeCommands: { windows: string | null; wsl: string | null };
}

function parseVersion(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function semverCompare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

/**
 * Check Ollama versions in both Windows and WSL, compare to latest release.
 * Returns detailed version info + upgrade commands.
 */
export async function checkOllamaVersions(): Promise<OllamaVersionInfo> {
  const result: OllamaVersionInfo = {
    windows: { installed: false, version: null, path: null },
    wsl: { installed: false, version: null, path: null },
    latest: null,
    windowsOutdated: false,
    wslOutdated: false,
    upgradeCommands: { windows: null, wsl: null },
  };

  // Check Windows Ollama
  const winVer = await tryExecAsync("ollama --version") ?? await tryExecAsync("ollama.exe --version");
  if (winVer && !winVer.includes("not recognized")) {
    result.windows.installed = true;
    result.windows.version = parseVersion(winVer);
    const winPath = await tryExecAsync("where ollama") ?? await tryExecAsync("where ollama.exe");
    if (winPath) result.windows.path = winPath.split("\n")[0].trim();
  }

  // Check WSL Ollama
  const wslVer = await tryExecAsync("wsl ollama --version") ?? await tryExecAsync("wsl bash -lc 'ollama --version'");
  if (wslVer && !wslVer.includes("not found") && !wslVer.includes("command not found")) {
    result.wsl.installed = true;
    result.wsl.version = parseVersion(wslVer);
    const wslPath = await tryExecAsync("wsl bash -lc 'which ollama'");
    if (wslPath) result.wsl.path = wslPath.trim();
  }

  // Check latest version from GitHub
  try {
    const r = await fetch("https://api.github.com/repos/ollama/ollama/releases/latest", {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "notoken" },
    });
    if (r.ok) {
      const data = await r.json() as { tag_name?: string };
      result.latest = parseVersion(data.tag_name ?? "");
    }
  } catch { /* offline, rate limited, etc */ }

  // Compare versions
  if (result.latest) {
    if (result.windows.version && semverCompare(result.windows.version, result.latest) < 0) {
      result.windowsOutdated = true;
      result.upgradeCommands.windows = "winget upgrade Ollama.Ollama";
    }
    if (result.wsl.version && semverCompare(result.wsl.version, result.latest) < 0) {
      result.wslOutdated = true;
      result.upgradeCommands.wsl = "curl -fsSL https://ollama.com/install.sh | sh";
    }
  }

  return result;
}
