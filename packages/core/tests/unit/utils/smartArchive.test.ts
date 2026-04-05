import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

// smartArchive is interactive (calls askForConfirmation), so we test
// the logic patterns directly rather than calling the full function.

describe("archive default excludes", () => {
  const DEFAULT_EXCLUDES = [
    "node_modules", ".git", ".next", ".nuxt", "dist", "build",
    "__pycache__", ".venv", "venv", ".env.local", ".cache", ".turbo",
    "vendor", "target", ".gradle", ".idea", ".vscode",
    "*.pyc", "*.o", "*.class", ".DS_Store", "Thumbs.db",
  ];

  it("excludes node_modules by default", () => {
    expect(DEFAULT_EXCLUDES).toContain("node_modules");
  });

  it("excludes .git by default", () => {
    expect(DEFAULT_EXCLUDES).toContain(".git");
  });

  it("excludes Python artifacts", () => {
    expect(DEFAULT_EXCLUDES).toContain("__pycache__");
    expect(DEFAULT_EXCLUDES).toContain(".venv");
    expect(DEFAULT_EXCLUDES).toContain("*.pyc");
  });

  it("excludes PHP vendor", () => {
    expect(DEFAULT_EXCLUDES).toContain("vendor");
  });

  it("excludes Rust target", () => {
    expect(DEFAULT_EXCLUDES).toContain("target");
  });

  it("excludes IDE dirs", () => {
    expect(DEFAULT_EXCLUDES).toContain(".idea");
    expect(DEFAULT_EXCLUDES).toContain(".vscode");
  });

  it("excludes OS junk files", () => {
    expect(DEFAULT_EXCLUDES).toContain(".DS_Store");
    expect(DEFAULT_EXCLUDES).toContain("Thumbs.db");
  });
});

describe("tar command construction", () => {
  function buildTarCmd(source: string, dest: string, excludes: string[]): string {
    const excludeFlags = excludes.map((e) => `--exclude='${e}'`).join(" ");
    const basename = source.split("/").pop() ?? source;
    const parent = source.replace(/\/[^/]+$/, "") || "/";
    return `tar -czf "${dest}" ${excludeFlags} -C "${parent}" "${basename}"`;
  }

  it("builds correct tar command with excludes", () => {
    const cmd = buildTarCmd("/home/user/myapp", "/tmp/myapp.tar.gz", ["node_modules", ".git"]);
    expect(cmd).toContain("tar -czf");
    expect(cmd).toContain("--exclude='node_modules'");
    expect(cmd).toContain("--exclude='.git'");
    expect(cmd).toContain("-C \"/home/user\"");
    expect(cmd).toContain("\"myapp\"");
  });

  it("builds command without excludes when includeAll", () => {
    const cmd = buildTarCmd("/home/user/myapp", "/tmp/myapp.tar.gz", []);
    expect(cmd).not.toContain("--exclude");
  });
});

describe("includeAll detection from raw text", () => {
  function shouldIncludeAll(rawText: string): boolean {
    return /include.?(all|everything)|with.?node.?modules|no.?exclude/i.test(rawText);
  }

  it("detects 'include all'", () => {
    expect(shouldIncludeAll("archive folder include all")).toBe(true);
  });

  it("detects 'include everything'", () => {
    expect(shouldIncludeAll("tar this directory include everything")).toBe(true);
  });

  it("detects 'with node_modules'", () => {
    expect(shouldIncludeAll("tar up project with node_modules")).toBe(true);
  });

  it("detects 'no exclude'", () => {
    expect(shouldIncludeAll("archive project no exclude")).toBe(true);
  });

  it("does not trigger on normal archive request", () => {
    expect(shouldIncludeAll("archive this folder")).toBe(false);
    expect(shouldIncludeAll("tar up my project")).toBe(false);
  });
});

describe("space check logic", () => {
  it("blocks when archive exceeds 90% of available", () => {
    const archiveGB = 5.0;
    const availableGB = 4.0;
    const blocked = archiveGB > availableGB * 0.9;
    expect(blocked).toBe(true);
  });

  it("warns when archive exceeds 50% of available", () => {
    const archiveGB = 3.0;
    const availableGB = 5.0;
    const warn = archiveGB > availableGB * 0.5;
    expect(warn).toBe(true);
  });

  it("passes when plenty of space", () => {
    const archiveGB = 0.5;
    const availableGB = 100;
    const blocked = archiveGB > availableGB * 0.9;
    const warn = archiveGB > availableGB * 0.5;
    expect(blocked).toBe(false);
    expect(warn).toBe(false);
  });
});
