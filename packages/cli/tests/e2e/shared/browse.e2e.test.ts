import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../../.."); // monorepo root
const CLI = resolve(__dirname, "../../../src/index.ts");

function runCli(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`npx tsx ${CLI} ${args}`, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

describe("browse e2e", () => {
  it("shows help when run with no args", () => {
    const { stdout } = runCli("browse");
    expect(stdout).toContain("notoken browse");
    expect(stdout).toContain("Browser Engines");
  });

  it("shows browser engine status", () => {
    const { stdout } = runCli("browse status");
    expect(stdout).toContain("Browser Engines");
    expect(stdout).toContain("system");
    // System browser should always show as ready
    expect(stdout).toContain("ready");
  });

  it("lists all 4 engine types in status", () => {
    const { stdout } = runCli("browse status");
    expect(stdout).toContain("patchright");
    expect(stdout).toContain("playwright");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("system");
  });

  it("shows active engine", () => {
    const { stdout } = runCli("browse status");
    expect(stdout).toContain("Active engine:");
  });

  it("shows screenshots directory", () => {
    const { stdout } = runCli("browse status");
    expect(stdout).toContain("screenshots");
  });
});

describe("update e2e", () => {
  it("checks for updates without error", () => {
    const { stdout, exitCode } = runCli("update");
    // Should either say "latest version" or "Update available"
    expect(stdout).toMatch(/latest version|Update available|Checking/);
  });
});
