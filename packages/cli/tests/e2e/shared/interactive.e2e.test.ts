import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../../.."); // monorepo root
const CLI = resolve(__dirname, "../../../dist/index.js");

function runInteractiveExpect(commands: string[], expectPatterns: string[], timeout = 20): string {
  // Build expect script that sends commands and looks for patterns
  const sendCmds = commands.map(cmd => `
    sleep 1
    send "${cmd}\\r"
    sleep 3
  `).join("\n");

  const expectScript = `
    log_user 1
    set timeout ${timeout}
    spawn node ${CLI}
    sleep 4
    expect -re "notoken|❯|>"
    ${sendCmds}
    send "exit\\r"
    expect eof
  `;

  try {
    const output = execSync(`expect -c '${expectScript.replace(/'/g, "'\\''")}'`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: (timeout + 15) * 1000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

describe("interactive mode e2e", () => {
  it("responds to 'hi' with a greeting", () => {
    const output = runInteractiveExpect(["hi"], ["greeting"]);
    // Should NOT contain codex auth message
    expect(output).not.toContain("authenticate");
    expect(output).not.toContain("Codex");
    // Should contain chat.greeting intent
    expect(output).toContain("chat.greeting");
  });

  it("responds to 'help' with available commands", () => {
    const output = runInteractiveExpect([":help"], ["help"]);
    expect(output.toLowerCase()).toContain("help");
  });

  it("handles unknown input gracefully", () => {
    const output = runInteractiveExpect(["xyzzy foobar"], []);
    // Should not crash, should not prompt for codex auth
    expect(output).not.toContain("authenticate");
    expect(output).not.toContain("Codex");
  });

  it("parses 'restart nginx' as service.restart", () => {
    const output = runInteractiveExpect(["restart nginx"], ["service.restart"]);
    expect(output).toContain("service.restart");
  });
});
