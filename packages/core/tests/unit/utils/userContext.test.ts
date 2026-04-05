import { describe, it, expect, beforeEach } from "vitest";
import { getUserContext, detectUserMismatch, findFreshestClaudeToken, getAuthProfilesPath, resetUserContext } from "../../../src/utils/userContext.js";

describe("getUserContext", () => {
  beforeEach(() => resetUserContext());

  it("returns a valid user context", () => {
    const ctx = getUserContext();
    expect(ctx).toHaveProperty("effectiveUser");
    expect(ctx).toHaveProperty("loginUser");
    expect(ctx).toHaveProperty("homeDir");
    expect(ctx).toHaveProperty("isRoot");
    expect(ctx).toHaveProperty("isWSL");
    expect(ctx).toHaveProperty("isWindows");
    expect(ctx).toHaveProperty("openclawHome");
    expect(ctx).toHaveProperty("claudeCredsPath");
    expect(ctx).toHaveProperty("codexAuthPath");
    expect(ctx).toHaveProperty("notokenHome");
  });

  it("effectiveUser is a non-empty string", () => {
    const ctx = getUserContext();
    expect(ctx.effectiveUser.length).toBeGreaterThan(0);
  });

  it("homeDir is a valid path", () => {
    const ctx = getUserContext();
    expect(ctx.homeDir).toMatch(/^\//);
  });

  it("openclawHome contains .openclaw", () => {
    const ctx = getUserContext();
    expect(ctx.openclawHome).toContain(".openclaw");
  });

  it("claudeCredsPath contains .claude", () => {
    const ctx = getUserContext();
    expect(ctx.claudeCredsPath).toContain(".claude");
  });

  it("caches result on second call", () => {
    const ctx1 = getUserContext();
    const ctx2 = getUserContext();
    expect(ctx1).toBe(ctx2); // Same object reference
  });

  it("resetUserContext clears cache", () => {
    const ctx1 = getUserContext();
    resetUserContext();
    const ctx2 = getUserContext();
    expect(ctx1).not.toBe(ctx2); // Different object
    expect(ctx1.effectiveUser).toBe(ctx2.effectiveUser); // Same values
  });
});

describe("detectUserMismatch", () => {
  it("returns an object with mismatch and message", () => {
    const result = detectUserMismatch();
    expect(result).toHaveProperty("mismatch");
    expect(result).toHaveProperty("message");
    expect(typeof result.mismatch).toBe("boolean");
  });
});

describe("getAuthProfilesPath", () => {
  it("returns a path containing auth-profiles.json", () => {
    const path = getAuthProfilesPath();
    expect(path).toContain("auth-profiles.json");
    expect(path).toContain(".openclaw");
  });
});

describe("findFreshestClaudeToken", () => {
  it("returns token object or null", () => {
    const result = findFreshestClaudeToken();
    if (result) {
      expect(result).toHaveProperty("token");
      expect(result).toHaveProperty("expires");
      expect(result).toHaveProperty("source");
      expect(typeof result.token).toBe("string");
      expect(typeof result.expires).toBe("number");
    }
    // null is also valid if no Claude credentials exist
  });
});
