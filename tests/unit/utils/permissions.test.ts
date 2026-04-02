import { describe, it, expect } from "vitest";
import { getLocalPermissions, parsePermissionRequest, checkAccessForIntent, formatPermissionsDisplay } from "../../../packages/core/src/utils/permissions.js";
import { resolve } from "node:path";

describe("getLocalPermissions", () => {
  it("gets permissions for an existing file", () => {
    const perms = getLocalPermissions(resolve(process.cwd(), "package.json"));
    expect(perms.exists).toBe(true);
    expect(perms.type).toBe("file");
    expect(perms.readable).toBe(true);
    expect(perms.octal.length).toBeGreaterThanOrEqual(3);
  });

  it("returns exists=false for missing file", () => {
    const perms = getLocalPermissions("/nonexistent/file/xyz");
    expect(perms.exists).toBe(false);
    expect(perms.readable).toBe(false);
  });

  it("detects directories", () => {
    const perms = getLocalPermissions(resolve(process.cwd(), "packages"));
    expect(perms.exists).toBe(true);
    expect(perms.type).toBe("directory");
  });
});

describe("parsePermissionRequest", () => {
  it("parses octal mode", () => {
    const result = parsePermissionRequest("set 755");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("755");
  });

  it("parses 'make executable'", () => {
    const result = parsePermissionRequest("make executable");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("+x");
  });

  it("parses 'secure'", () => {
    const result = parsePermissionRequest("secure this file");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("600");
  });

  it("parses 'read only'", () => {
    const result = parsePermissionRequest("set read only");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("444");
  });

  it("parses 'owner only'", () => {
    const result = parsePermissionRequest("owner only access");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("700");
  });

  it("parses 'give write'", () => {
    const result = parsePermissionRequest("give write permission");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("+w");
  });

  it("parses 'remove execute'", () => {
    const result = parsePermissionRequest("remove execute permission");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("-x");
  });

  it("returns null for unrecognized", () => {
    const result = parsePermissionRequest("do something random");
    expect(result).toBeNull();
  });
});

describe("checkAccessForIntent", () => {
  it("returns null when file is readable for read intents", () => {
    const perms = { path: "/test", exists: true, readable: true, writable: false, executable: false } as any;
    expect(checkAccessForIntent("file.parse", perms)).toBeNull();
  });

  it("returns error when file is not readable", () => {
    const perms = { path: "/test", exists: true, readable: false, writable: false, executable: false, owner: "root", octal: "600" } as any;
    expect(checkAccessForIntent("file.parse", perms)).toContain("Permission denied");
  });

  it("returns error when file is not writable for write intents", () => {
    const perms = { path: "/test", exists: true, readable: true, writable: false, executable: false, owner: "root", octal: "644" } as any;
    const err = checkAccessForIntent("env.set", perms);
    expect(err).toContain("Permission denied");
    expect(err).toContain("sudo");
  });

  it("returns error for non-existent file", () => {
    const perms = { path: "/missing", exists: false } as any;
    expect(checkAccessForIntent("file.parse", perms)).toContain("not found");
  });
});

describe("formatPermissionsDisplay", () => {
  it("formats existing file", () => {
    const perms = getLocalPermissions(resolve(process.cwd(), "package.json"));
    const display = formatPermissionsDisplay(perms);
    expect(display).toContain("package.json");
    expect(display).toContain("file");
  });

  it("formats missing file", () => {
    const perms = getLocalPermissions("/nonexistent");
    const display = formatPermissionsDisplay(perms);
    expect(display).toContain("Not found");
  });
});
