/**
 * LLM provider action helpers — install & auth commands, cross-env diagnostics.
 */

import { tryExecAsync } from "./asyncExec.js";
import { checkEnv } from "./crossPlatform.js";

/* ── types ── */

export interface LLMDiagnosis {
  provider: string;
  installed: boolean;
  version: string | null;
  env: string;
  issues: string[];
  environments: Array<{
    label: string;
    installed: boolean;
    version: string | null;
    authenticated: boolean | null;
    user: string | null;
    path: string | null;
    debug?: string[];
  }>;
  info: Record<string, unknown>;
}

/* ── command maps ── */

const actionCmds: Record<string, Record<string, string>> = {
  "auth-windows": {
    claude: 'start cmd /c claude login',
    codex: 'start cmd /c codex login',
  },
  "auth-wsl": {
    claude: "start cmd /c wsl bash -lc 'claude login'",
    codex: "start cmd /c wsl bash -lc 'codex login'",
  },
  "install-windows": {
    claude: "start cmd /k npm install -g @anthropic-ai/claude-code",
    codex: "start cmd /k npm install -g @openai/codex",
    ollama: "start cmd /k winget install Ollama.Ollama",
    openclaw: "start cmd /k npm install -g openclaw",
  },
  "install-wsl": {
    claude: "wsl bash -lc 'npm install -g @anthropic-ai/claude-code'",
    codex: "wsl bash -lc 'npm install -g @openai/codex'",
    ollama: "wsl bash -lc 'curl -fsSL https://ollama.com/install.sh | sh'",
    openclaw: "wsl bash -lc 'npm install -g openclaw'",
  },
};

/**
 * Get the shell command to auth or install a given LLM provider in a
 * specific environment.
 *
 * @returns The command string, or `null` if the combination is unknown.
 */
export function getLLMCommand(
  action: "auth" | "install",
  provider: string,
  env: "Windows" | "WSL",
): string | null {
  const key = `${action}-${env.toLowerCase()}`;
  return actionCmds[key]?.[provider] ?? null;
}

/* ── diagnostics ── */

const authCmds: Record<string, string> = {
  claude: "claude auth status",
  codex: "codex login status",
};

/**
 * Diagnose an LLM provider across Windows and WSL: version, auth status,
 * provider-specific extras (Ollama model counts, OpenClaw gateway health).
 */
export async function diagnoseLLM(provider: string): Promise<LLMDiagnosis> {
  const result: LLMDiagnosis = {
    provider,
    installed: false,
    version: null,
    env: "none",
    issues: [],
    environments: [],
    info: {},
  };

  const authCmd = authCmds[provider] ?? null;

  // ── Windows environment ──
  const isWin32 = process.platform === "win32";
  const winPrefix = isWin32 ? "" : "/mnt/c/Windows/System32/cmd.exe /c ";
  const winEnv = await checkEnv(provider, "Windows", winPrefix, authCmd ?? undefined);
  if (winEnv.installed) result.environments.push(winEnv);

  // ── WSL environment ──
  const wslPrefix = isWin32 ? "wsl " : "";
  const wslEnv = {
    label: "WSL",
    installed: false,
    version: null as string | null,
    authenticated: null as boolean | null,
    user: null as string | null,
    path: null as string | null,
    debug: [] as string[],
  };

  const wslVer = await tryExecAsync(
    `${wslPrefix}bash -lc '${provider} --version'`,
  );
  if (
    wslVer &&
    !wslVer.includes("not found") &&
    !wslVer.includes("command not found")
  ) {
    wslEnv.installed = true;
    wslEnv.version = wslVer.split("\n")[0].trim();

    if (authCmd) {
      const wslAuth = await tryExecAsync(
        `${wslPrefix}bash -lc '${authCmd}'`,
        10000,
      );
      wslEnv.authenticated = !!(
        wslAuth &&
        (wslAuth.includes("authenticated") ||
          wslAuth.includes("Logged in") ||
          wslAuth.includes('"loggedIn": true') ||
          wslAuth.includes('"loggedIn":true') ||
          wslAuth.includes("API key") ||
          wslAuth.includes("oauth"))
      );
    }

    const wslUser = await tryExecAsync(`${wslPrefix}whoami`);
    if (wslUser) wslEnv.user = wslUser.trim();

    const wslPath = await tryExecAsync(
      `${wslPrefix}bash -lc 'which ${provider}'`,
    );
    if (wslPath) wslEnv.path = wslPath.trim();

    result.environments.push(wslEnv);
  }

  // ── overall status from best environment ──
  const bestEnv =
    result.environments.find((e) => e.authenticated) ||
    result.environments.find((e) => e.installed) ||
    null;

  if (bestEnv) {
    result.installed = true;
    result.version = bestEnv.version;
    result.env = bestEnv.label;
    result.info.authenticated = bestEnv.authenticated;
  }

  if (!result.installed) {
    result.issues.push(`${provider} is not installed`);
  } else if (!result.environments.some((e) => e.authenticated)) {
    result.issues.push("Not authenticated. Click Authorize to log in.");
  }

  // ── provider-specific extras ──

  if (provider === "ollama") {
    let winModels = 0;
    let wslModels = 0;

    try {
      const r = await fetch("http://127.0.0.1:11434/api/tags", {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const d = (await r.json()) as {
          models?: Array<{ name: string }>;
        };
        winModels = d.models?.length || 0;
        result.info.windowsModels = winModels;
        result.info.models = d.models?.map((m) => m.name) || [];
      }
    } catch {
      /* ignore */
    }

    const wslTags = await tryExecAsync(
      "wsl curl -sf http://127.0.0.1:11434/api/tags",
      10000,
    );
    if (wslTags) {
      const j = wslTags.indexOf("{");
      if (j >= 0) {
        try {
          const d = JSON.parse(wslTags.substring(j)) as {
            models?: Array<{ name: string }>;
          };
          wslModels = d.models?.length || 0;
          result.info.wslModels = wslModels;
          if (!(result.info.models as string[])?.length) {
            result.info.models = d.models?.map((m) => m.name) || [];
          }
        } catch {
          /* ignore */
        }
      }
    }

    result.info.totalModels = winModels + wslModels;
    if (winModels === 0 && wslModels > 0)
      result.issues.push("Windows Ollama has no models — using WSL");
    if (winModels === 0 && wslModels === 0)
      result.issues.push("No models installed. Run: ollama pull llama3.2");
  }

  if (provider === "openclaw") {
    const health = await tryExecAsync(
      "curl -sf http://127.0.0.1:18789/health",
    );
    if (health) {
      result.info.gateway = "healthy";
    } else {
      result.issues.push("Gateway not running. Run: start openclaw");
    }

    const modelsOut =
      (await tryExecAsync("wsl bash -lc 'openclaw models'", 10000)) ??
      (await tryExecAsync("openclaw models", 10000));
    if (modelsOut) {
      const dm = modelsOut.match(/Default\s*:\s*(.+)/);
      if (dm) result.info.defaultModel = dm[1].trim();
      const cm = modelsOut.match(/Configured models \((\d+)\)/);
      if (cm) result.info.configuredModels = parseInt(cm[1], 10);
    }
  }

  return result;
}
