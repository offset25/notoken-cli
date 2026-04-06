/**
 * Cross-platform CLI detection helpers.
 *
 * Works across native, WSL, wsl bash -lc, and .exe environments so the
 * same logic can drive both the Electron app and the CLI.
 */

import { platform as osPlatform, release as osRelease } from "node:os";
import { tryExecAsync } from "./asyncExec.js";

/* ── tiny platform helpers ── */

/** True when the current Node process is running inside WSL. */
export function isWSL(): boolean {
  if (osPlatform() !== "linux") return false;
  return (
    process.env.WSL_DISTRO_NAME !== undefined ||
    process.env.WSLENV !== undefined ||
    (() => {
      try {
        return osRelease().toLowerCase().includes("microsoft");
      } catch {
        return false;
      }
    })()
  );
}

/** True when the current Node process is running on native Windows. */
export function isWindows(): boolean {
  return osPlatform() === "win32";
}

/* ── CLI location result ── */

export interface CliInfo {
  cmd: string;
  env: string;
  wrap?: boolean;
  name?: string;
  version: string;
}

/**
 * Locate a CLI tool across native → WSL → wsl bash -lc → .exe.
 *
 * Returns a descriptor that {@link buildCliExec} can turn into a full
 * command line, or `null` when the tool cannot be found anywhere.
 */
export async function findCliCmd(name: string): Promise<CliInfo | null> {
  // 1. Native (works on Windows if installed globally, or in WSL if running there)
  const native = await tryExecAsync(`${name} --version`);
  if (
    native &&
    !native.includes("not recognized") &&
    !native.includes("not found")
  ) {
    return { cmd: name, env: "native", version: native.split("\n")[0] };
  }

  // 2. wsl direct
  const wslDirect = await tryExecAsync(`wsl ${name} --version`);
  if (wslDirect && !wslDirect.includes("not found")) {
    return {
      cmd: `wsl ${name}`,
      env: "WSL",
      version: wslDirect.split("\n")[0],
    };
  }

  // 3. wsl bash -lc (for nvm-installed tools)
  const wslBash = await tryExecAsync(`wsl bash -lc '${name} --version'`);
  if (
    wslBash &&
    !wslBash.includes("not found") &&
    !wslBash.includes("command not found")
  ) {
    return {
      cmd: "wsl bash -lc",
      env: "WSL",
      wrap: true,
      name,
      version: wslBash.split("\n")[0],
    };
  }

  // 4. .exe suffix (Windows executable from WSL)
  const winExe = await tryExecAsync(`${name}.exe --version`);
  if (winExe && !winExe.includes("not recognized")) {
    return {
      cmd: `${name}.exe`,
      env: "Windows",
      version: winExe.split("\n")[0],
    };
  }

  return null;
}

/**
 * Build a ready-to-exec command string from a {@link CliInfo} descriptor.
 *
 * When `wrap` is set (wsl bash -lc), the tool name and args are wrapped in
 * single quotes so the command survives cmd.exe → wsl → bash.
 */
export function buildCliExec(cliInfo: CliInfo, args: string): string {
  if (cliInfo.wrap) return `${cliInfo.cmd} '${cliInfo.name} ${args}'`;
  return `${cliInfo.cmd} ${args}`;
}

/* ── per-environment check ── */

export interface EnvCheckResult {
  label: string;
  installed: boolean;
  version: string | null;
  authenticated: boolean | null;
  user: string | null;
  path: string | null;
  debug: string[];
}

/**
 * Check whether a CLI tool is available (and optionally authenticated) in a
 * specific environment (Windows, WSL, native, …).
 *
 * @param name      CLI binary name, e.g. `"claude"`.
 * @param label     Human-readable label for the environment, e.g. `"Windows"`.
 * @param cmdPrefix Prefix that targets the environment, e.g. `"/mnt/c/Windows/System32/cmd.exe /c "`.
 * @param authCmd   Optional auth-check command fragment, e.g. `"claude auth status"`.
 */
export async function checkEnv(
  name: string,
  label: string,
  cmdPrefix: string,
  authCmd?: string,
): Promise<EnvCheckResult> {
  const env: EnvCheckResult = {
    label,
    installed: false,
    version: null,
    authenticated: null,
    user: null,
    path: null,
    debug: [],
  };

  const verCmd = `${cmdPrefix}${name} --version`;
  env.debug.push(`ver cmd: ${verCmd}`);
  const verOut = await tryExecAsync(verCmd);
  env.debug.push(`ver out: ${verOut ? verOut.substring(0, 80) : "null"}`);

  if (
    !verOut ||
    verOut.includes("not recognized") ||
    verOut.includes("not found") ||
    verOut.includes("command not found")
  ) {
    return env;
  }

  env.installed = true;
  env.version = verOut.split("\n")[0].trim();

  // Auth check
  if (authCmd) {
    const authCmdFull = `${cmdPrefix}${authCmd}`;
    env.debug.push(`auth cmd: ${authCmdFull}`);
    const authOut = await tryExecAsync(authCmdFull, 10000);
    env.debug.push(`auth out: ${authOut ? authOut.substring(0, 100) : "null"}`);
    env.authenticated = !!(
      authOut &&
      (authOut.includes("authenticated") ||
        authOut.includes("Logged in") ||
        authOut.includes('"loggedIn": true') ||
        authOut.includes('"loggedIn":true') ||
        authOut.includes("API key") ||
        authOut.includes("oauth"))
    );
  }

  // User
  const isWinCmd = cmdPrefix.includes("cmd.exe");
  const userOut = await tryExecAsync(
    `${cmdPrefix}${isWinCmd ? "whoami" : "whoami"}`,
  );
  if (userOut) env.user = userOut.trim().split("\n").pop()!.trim();

  // Path
  const pathOut = await tryExecAsync(
    `${cmdPrefix}${isWinCmd ? "where " + name : "which " + name}`,
  );
  if (pathOut) env.path = pathOut.trim().split("\n").pop()!.trim();

  return env;
}
