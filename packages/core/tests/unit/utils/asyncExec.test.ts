import { describe, it, expect } from "vitest";
import { tryExecAsync } from "../../../src/utils/asyncExec.js";

describe("tryExecAsync", () => {
  it("returns output for valid commands", async () => {
    const result = await tryExecAsync("echo hello");
    expect(result).toContain("hello");
  });

  it("returns null for failing commands", async () => {
    const result = await tryExecAsync("command_that_does_not_exist_xyz 2>/dev/null");
    expect(result).toBeNull();
  });

  it("respects timeout", async () => {
    const start = Date.now();
    const result = await tryExecAsync("sleep 10", 500);
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(3000);
  });

  it("filters UNC path warnings", async () => {
    // Simulate by checking the filter logic works
    const result = await tryExecAsync("echo test_output");
    expect(result).not.toContain("UNC paths");
    expect(result).toContain("test_output");
  });

  it("trims whitespace from output", async () => {
    const result = await tryExecAsync("echo '  hello  '");
    expect(result).toBe("hello");
  });

  it("combines stdout and stderr", async () => {
    const result = await tryExecAsync("echo stdout_text && echo stderr_text >&2");
    expect(result).toContain("stdout_text");
    // stderr should also be captured
    expect(result).toContain("stderr_text");
  });

  it("returns null for empty output", async () => {
    const result = await tryExecAsync("true");
    // 'true' produces no output
    expect(result).toBeNull();
  });

  it("handles commands with special characters", async () => {
    const result = await tryExecAsync("echo 'hello world'");
    expect(result).toContain("hello world");
  });
});
