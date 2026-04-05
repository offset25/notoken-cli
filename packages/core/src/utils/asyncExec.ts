/**
 * Async exec helper with timeout, stdout+stderr combining, and
 * filtering of common Windows/WSL noise (UNC-path warnings, etc.).
 */

import { exec } from "node:child_process";

/**
 * Run a shell command and return the cleaned output, or `null` on failure.
 *
 * - Combines stdout + stderr (some tools write to stderr).
 * - Filters UNC-path warnings and wsl.localhost lines.
 * - Returns `null` when the command fails or produces no useful output.
 */
export function tryExecAsync(
  cmd: string,
  timeout = 5000,
): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { encoding: "utf-8", timeout, windowsHide: true },
      (_err, stdout, stderr) => {
        if (_err) return resolve(null);

        const combined = ((stdout || "") + "\n" + (stderr || "")).trim();
        if (!combined) return resolve(null);

        const lines = combined.split("\n").filter(
          (l) =>
            !l.includes("UNC paths are not supported") &&
            !l.includes("CMD.EXE was started") &&
            !l.includes("Defaulting to Windows directory") &&
            !l.match(/^'\\\\wsl/) &&
            !l.match(/^\\\\wsl/),
        );

        resolve(lines.join("\n").trim() || null);
      },
    );
  });
}
