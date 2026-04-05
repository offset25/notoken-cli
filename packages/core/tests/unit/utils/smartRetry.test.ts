import { describe, it, expect } from "vitest";
import { analyzeFailure } from "../../../src/utils/smartRetry.js";

describe("smartRetry — analyzeFailure", () => {
  it('returns fix for "command not found: nginx"', () => {
    const result = analyzeFailure("restart nginx", "command not found: nginx");
    expect(result).not.toBeNull();
    expect(result!.canFix).toBe(true);
    expect(result!.suggestion).toContain("nginx");
    expect(result!.fixCommand).toBe("install nginx");
  });

  it('returns fix for "connection refused"', () => {
    const result = analyzeFailure("check status", "connection refused", { service: "redis" });
    expect(result).not.toBeNull();
    expect(result!.canFix).toBe(true);
    expect(result!.suggestion).toContain("redis");
    expect(result!.fixCommand).toBe("start redis");
  });

  it('returns fix for "permission denied"', () => {
    const result = analyzeFailure("restart nginx", "permission denied");
    expect(result).not.toBeNull();
    expect(result!.canFix).toBe(true);
    expect(result!.suggestion.toLowerCase()).toContain("permission");
    expect(result!.fixCommand).toBe("sudo restart nginx");
  });

  it('returns fix for "No such file or directory: config.json"', () => {
    const result = analyzeFailure("read config", "No such file or directory: config.json");
    expect(result).not.toBeNull();
    expect(result!.canFix).toBe(true);
    expect(result!.suggestion).toContain("config.json");
    expect(result!.fixCommand).toBe("find config.json");
  });

  it('returns fix for "No space left on device"', () => {
    const result = analyzeFailure("deploy app", "No space left on device");
    expect(result).not.toBeNull();
    expect(result!.canFix).toBe(true);
    expect(result!.suggestion.toLowerCase()).toContain("disk");
    expect(result!.fixCommand).toBe("free up space");
  });

  it('returns fix for "ECONNREFUSED"', () => {
    const result = analyzeFailure("check api", "ECONNREFUSED", { service: "api" });
    expect(result).not.toBeNull();
    expect(result!.canFix).toBe(true);
    expect(result!.suggestion).toBeTruthy();
    expect(result!.fixCommand).toBeTruthy();
  });

  it('returns fix for "timeout"', () => {
    const result = analyzeFailure("deploy app", "operation timed out");
    expect(result).not.toBeNull();
    expect(result!.canFix).toBe(true);
    expect(result!.suggestion.toLowerCase()).toContain("timed out");
    expect(result!.fixCommand).toBe("deploy app");
  });

  it("returns null for unknown errors", () => {
    const result = analyzeFailure("do stuff", "something completely unrecognized happened");
    expect(result).toBeNull();
  });

  it("each known fix has canFix=true, non-empty suggestion and fixCommand", () => {
    const cases = [
      { error: "command not found: curl" },
      { error: "connection refused" },
      { error: "permission denied" },
      { error: "No such file or directory: foo.txt" },
      { error: "No space left on device" },
      { error: "timed out" },
    ];
    for (const { error } of cases) {
      const result = analyzeFailure("test", error);
      expect(result).not.toBeNull();
      expect(result!.canFix).toBe(true);
      expect(result!.suggestion.length).toBeGreaterThan(0);
      expect(result!.fixCommand.length).toBeGreaterThan(0);
    }
  });
});
