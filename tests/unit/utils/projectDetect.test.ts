import { describe, it, expect } from "vitest";
import { detectProjects, readProjectConfig, getScriptRunCmd, getSystemUpdateCmd, formatProjectDetection, formatPackageScripts } from "../../../packages/core/src/utils/projectDetect.js";
import { resolve } from "node:path";

describe("detectProjects", () => {
  it("detects Node.js/TypeScript in current repo", () => {
    const projects = detectProjects();
    expect(projects.length).toBeGreaterThan(0);
    const node = projects.find((p) => p.type.includes("Node") || p.type.includes("TypeScript"));
    expect(node).toBeDefined();
    expect(node!.packageManager).toBe("npm");
    expect(node!.configFile).toBe("package.json");
  });

  it("returns install and update commands", () => {
    const projects = detectProjects();
    expect(projects[0].installCmd).toBeTruthy();
    expect(projects[0].updateCmd).toBeTruthy();
  });

  it("detects lock file", () => {
    const projects = detectProjects();
    const node = projects.find((p) => p.configFile === "package.json");
    expect(node?.lockFile).toBe("package-lock.json");
  });

  it("returns empty for nonexistent directory", () => {
    const projects = detectProjects("/tmp/nonexistent-dir-xyz");
    expect(projects).toHaveLength(0);
  });
});

describe("readProjectConfig", () => {
  it("reads package.json in current repo", () => {
    const info = readProjectConfig();
    expect(info).not.toBeNull();
    expect(info!.name).toBeDefined();
    expect(info!.packageManager).toBeDefined();
    expect(Object.keys(info!.scripts).length).toBeGreaterThan(0);
  });

  it("lists scripts from package.json", () => {
    const info = readProjectConfig();
    expect(info!.scripts).toHaveProperty("build");
    expect(info!.scripts).toHaveProperty("test");
    expect(info!.scripts).toHaveProperty("dev");
  });

  it("lists dependencies", () => {
    const info = readProjectConfig();
    expect(info!.dependencies).toBeDefined();
    expect(info!.devDependencies).toBeDefined();
  });

  it("returns null for nonexistent directory", () => {
    const info = readProjectConfig("/tmp/nonexistent-dir-xyz");
    expect(info).toBeNull();
  });
});

describe("getScriptRunCmd", () => {
  it("resolves exact script name", () => {
    const cmd = getScriptRunCmd("build");
    expect(cmd).toBe("npm run build");
  });

  it("resolves dev script", () => {
    const cmd = getScriptRunCmd("dev");
    expect(cmd).toBe("npm run dev");
  });

  it("returns null for nonexistent script", () => {
    const cmd = getScriptRunCmd("nonexistent-script-xyz");
    expect(cmd).toBeNull();
  });

  it("fuzzy matches partial script names", () => {
    // "test" should match "test" or "test:unit" etc.
    const cmd = getScriptRunCmd("test");
    expect(cmd).toContain("test");
  });
});

describe("getSystemUpdateCmd", () => {
  it("returns a command string", () => {
    const cmd = getSystemUpdateCmd();
    expect(cmd).toBeTruthy();
    expect(typeof cmd).toBe("string");
  });
});

describe("formatProjectDetection", () => {
  it("returns empty message for no projects", () => {
    const result = formatProjectDetection([]);
    expect(result).toContain("No recognized projects");
  });

  it("shows project type and package manager", () => {
    const result = formatProjectDetection([{
      type: "Next.js",
      packageManager: "pnpm",
      installCmd: "pnpm install",
      updateCmd: "pnpm update",
      configFile: "package.json",
      lockFile: "pnpm-lock.yaml",
    }]);
    expect(result).toContain("Next.js");
    expect(result).toContain("pnpm");
    expect(result).toContain("pnpm install");
    expect(result).toContain("pnpm update");
  });
});

describe("formatPackageScripts", () => {
  it("shows scripts with run commands", () => {
    const result = formatPackageScripts({
      packageManager: "npm",
      scripts: { dev: "next dev", build: "next build" },
      dependencies: ["react", "next"],
      devDependencies: ["typescript"],
      name: "myapp",
      version: "1.0.0",
    });
    expect(result).toContain("myapp@1.0.0");
    expect(result).toContain("npm run dev");
    expect(result).toContain("npm run build");
    expect(result).toContain("react");
    expect(result).toContain("typescript");
  });

  it("uses correct prefix for yarn", () => {
    const result = formatPackageScripts({
      packageManager: "yarn",
      scripts: { dev: "next dev" },
      dependencies: [],
      devDependencies: [],
      name: "test",
      version: "0.0.1",
    });
    expect(result).toContain("yarn dev");
  });

  it("uses correct prefix for composer", () => {
    const result = formatPackageScripts({
      packageManager: "composer",
      scripts: { "post-install-cmd": "php artisan optimize" },
      dependencies: ["laravel/framework"],
      devDependencies: [],
      name: "mylaravel",
      version: "1.0.0",
    });
    expect(result).toContain("composer post-install-cmd");
    expect(result).toContain("laravel/framework");
  });

  it("shows empty message when no scripts", () => {
    const result = formatPackageScripts({
      packageManager: "npm",
      scripts: {},
      dependencies: [],
      devDependencies: [],
      name: "empty",
      version: "0.0.0",
    });
    expect(result).toContain("No scripts defined");
  });
});
