import { describe, it, expect } from "vitest";
import { detectLocalPlatform, getInstallCommand, getServiceCommand, getPackageForCommand } from "../../../packages/core/src/utils/platform.js";

describe("detectLocalPlatform", () => {
  it("returns a valid platform object", () => {
    const platform = detectLocalPlatform();
    expect(platform.os).toBeDefined();
    expect(["linux", "darwin", "windows", "unknown"]).toContain(platform.os);
    expect(platform.arch).toBeDefined();
  });

  it("detects package manager", () => {
    const platform = detectLocalPlatform();
    expect(["apt", "dnf", "yum", "pacman", "apk", "brew", "choco", "unknown"]).toContain(platform.packageManager);
  });
});

describe("getInstallCommand", () => {
  it("generates apt command for debian", () => {
    const cmd = getInstallCommand("nginx", { packageManager: "apt" } as any);
    expect(cmd).toContain("apt-get install -y nginx");
  });

  it("generates dnf command for rhel", () => {
    const cmd = getInstallCommand("nginx", { packageManager: "dnf" } as any);
    expect(cmd).toContain("dnf install -y nginx");
  });

  it("generates brew command for macos", () => {
    const cmd = getInstallCommand("nginx", { packageManager: "brew" } as any);
    expect(cmd).toContain("brew install nginx");
  });
});

describe("getServiceCommand", () => {
  it("generates systemctl command", () => {
    const cmd = getServiceCommand("restart", "nginx", { initSystem: "systemd" } as any);
    expect(cmd).toBe("sudo systemctl restart nginx");
  });

  it("generates service command for sysvinit", () => {
    const cmd = getServiceCommand("restart", "nginx", { initSystem: "sysvinit" } as any);
    expect(cmd).toBe("sudo service nginx restart");
  });
});

describe("getPackageForCommand", () => {
  it("maps dig to dnsutils on debian", () => {
    const pkg = getPackageForCommand("dig", { distroFamily: "debian" } as any);
    expect(pkg).toBe("dnsutils");
  });

  it("maps dig to bind-utils on rhel", () => {
    const pkg = getPackageForCommand("dig", { distroFamily: "rhel" } as any);
    expect(pkg).toBe("bind-utils");
  });

  it("returns command name for unknown commands", () => {
    const pkg = getPackageForCommand("mycustomtool", { distroFamily: "debian" } as any);
    expect(pkg).toBe("mycustomtool");
  });
});
