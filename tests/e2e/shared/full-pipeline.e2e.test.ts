import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const CLI = resolve(ROOT, "packages/cli/src/index.ts");

function runCli(args: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`npx tsx ${CLI} ${args}`, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
  }
}

describe("full pipeline e2e", () => {
  it("parses and dry-runs restart", () => {
    const { stdout, exitCode } = runCli('"restart nginx on prod" --dry-run');
    expect(exitCode).toBe(0);
    expect(stdout).toContain("service.restart");
    expect(stdout).toContain("dry-run");
  });

  it("outputs JSON when requested", () => {
    const { stdout } = runCli('"restart nginx on prod" --json --dry-run');
    const parsed = JSON.parse(stdout);
    expect(parsed.intent.intent).toBe("service.restart");
    expect(parsed.intent.fields.service).toBe("nginx");
    expect(parsed.intent.fields.environment).toBe("prod");
  });

  it("rejects unknown input with exit code 1", () => {
    const { exitCode } = runCli('"xyzzy foobar unknown thing" --dry-run');
    expect(exitCode).toBe(1);
  });

  it("parses deploy with branch", () => {
    const { stdout } = runCli('"deploy main to staging" --json --dry-run');
    const parsed = JSON.parse(stdout);
    expect(parsed.intent.intent).toBe("deploy.run");
    expect(parsed.intent.fields.branch).toBe("main");
  });

  it("parses copy with source and destination", () => {
    const { stdout } = runCli('"copy nginx.conf to /root on prod" --json --dry-run');
    const parsed = JSON.parse(stdout);
    expect(parsed.intent.intent).toBe("files.copy");
    expect(parsed.intent.fields.source).toBe("nginx.conf");
    expect(parsed.intent.fields.destination).toBe("/root");
  });

  it("shows help with --help", () => {
    const { stdout, exitCode } = runCli("--help");
    // help exits with 0
    expect(stdout).toContain("notoken");
    expect(stdout).toContain("Usage");
  });
});
