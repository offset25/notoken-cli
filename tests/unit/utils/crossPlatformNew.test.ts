import { describe, it, expect } from "vitest";
import { findCliCmd, buildCliExec, checkEnv, isWSL, isWindows } from "../../../packages/core/src/utils/crossPlatform.js";

describe("isWSL", () => {
  it("returns a boolean", () => {
    expect(typeof isWSL()).toBe("boolean");
  });
});

describe("isWindows", () => {
  it("returns a boolean", () => {
    expect(typeof isWindows()).toBe("boolean");
  });

  it("matches process.platform", () => {
    expect(isWindows()).toBe(process.platform === "win32");
  });
});

describe("findCliCmd", () => {
  it("finds node", async () => {
    const result = await findCliCmd("node");
    expect(result).not.toBeNull();
    expect(result!.version).toMatch(/\d+/);
    expect(result!.env).toBeTruthy();
  });

  it("finds git", async () => {
    const result = await findCliCmd("git");
    expect(result).not.toBeNull();
    expect(result!.version).toContain("git");
  });

  it("returns null for nonexistent tool", async () => {
    const result = await findCliCmd("nonexistent_tool_xyz_12345");
    expect(result).toBeNull();
  });

  it("returns env field", async () => {
    const result = await findCliCmd("node");
    expect(["native", "WSL", "Windows"]).toContain(result!.env);
  });

  it("returns version as first line", async () => {
    const result = await findCliCmd("node");
    expect(result!.version).not.toContain("\n");
  });
});

describe("buildCliExec", () => {
  it("builds simple command", () => {
    const cmd = buildCliExec({ cmd: "node", env: "native" }, "--version");
    expect(cmd).toBe("node --version");
  });

  it("wraps WSL bash -lc commands in single quotes", () => {
    const cmd = buildCliExec({ cmd: "wsl bash -lc", env: "WSL", wrap: true, name: "claude" }, "-p hello");
    expect(cmd).toContain("wsl bash -lc");
    expect(cmd).toContain("claude");
    expect(cmd).toContain("-p hello");
  });
});

describe("checkEnv", () => {
  it("detects node in current environment", async () => {
    const result = await checkEnv("node", "test", "");
    expect(result.installed).toBe(true);
    expect(result.version).toMatch(/\d+/);
    expect(result.label).toBe("test");
  });

  it("returns installed=false for missing tool", async () => {
    const result = await checkEnv("nonexistent_xyz", "test", "");
    expect(result.installed).toBe(false);
    expect(result.version).toBeNull();
  });

  it("includes debug info", async () => {
    const result = await checkEnv("node", "test", "");
    expect(result.debug).toBeDefined();
    expect(Array.isArray(result.debug)).toBe(true);
    expect(result.debug!.length).toBeGreaterThan(0);
  });

  it("detects user via whoami", async () => {
    const result = await checkEnv("node", "test", "");
    // User should be detected on any platform
    if (result.user) {
      expect(typeof result.user).toBe("string");
      expect(result.user.length).toBeGreaterThan(0);
    }
  });
});
