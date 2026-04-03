import { describe, it, expect } from "vitest";
import { runLocalCommand } from "../../../packages/core/src/execution/ssh.js";

describe("runLocalCommand — cross-platform shell", () => {
  it("executes a simple command", async () => {
    const result = await runLocalCommand("echo hello");
    expect(result.trim()).toContain("hello");
  });

  it("handles 2>/dev/null redirection (Unix syntax)", async () => {
    // This was the original bug — on Windows, cmd.exe doesn't understand 2>/dev/null
    const result = await runLocalCommand("echo works 2>/dev/null");
    expect(result.trim()).toContain("works");
  });

  it("runs node --version successfully", async () => {
    const result = await runLocalCommand("node --version 2>/dev/null");
    expect(result.trim()).toMatch(/^v\d+\.\d+/);
  });

  it("returns combined stdout+stderr when stderr is present", async () => {
    const result = await runLocalCommand("echo out && echo err >&2");
    expect(result).toContain("out");
    expect(result).toContain("err");
  });

  it("respects timeout parameter", async () => {
    await expect(
      runLocalCommand("sleep 10", 500)
    ).rejects.toThrow();
  });
});
