import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../packages/core/src/nlp/parseIntent.js";
import { detectProjects, readProjectConfig, getScriptRunCmd, formatProjectDetection, formatPackageScripts } from "../../../packages/core/src/utils/projectDetect.js";

describe("project: parse → detect pipeline", () => {
  it("parses 'what project is this' and detection finds a project", async () => {
    const result = await parseIntent("what project is this");
    expect(result.intent.intent).toBe("project.detect");

    // And detection actually works on this repo
    const projects = detectProjects();
    expect(projects.length).toBeGreaterThan(0);
    expect(projects[0].type).toContain("Node");
  });

  it("parses 'npm install' and resolves to project.install", async () => {
    const result = await parseIntent("npm install");
    expect(result.intent.intent).toBe("project.install");
  });

  it("parses 'run dev' and resolves to project.run", async () => {
    const result = await parseIntent("run dev");
    expect(result.intent.intent).toBe("project.run");
  });

  it("getScriptRunCmd resolves 'build' for this repo", () => {
    const cmd = getScriptRunCmd("build");
    expect(cmd).toBe("npm run build");
  });

  it("getScriptRunCmd resolves 'test' for this repo", () => {
    const cmd = getScriptRunCmd("test");
    expect(cmd).toContain("test");
  });
});

describe("project: format pipeline", () => {
  it("formatProjectDetection shows detected project", () => {
    const projects = detectProjects();
    const output = formatProjectDetection(projects);
    expect(output).toContain("Detected Projects");
    expect(output).toContain("npm");
  });

  it("formatPackageScripts shows scripts from this repo", () => {
    const info = readProjectConfig();
    expect(info).not.toBeNull();
    const output = formatPackageScripts(info!);
    expect(output).toContain("notoken");
    expect(output).toContain("npm run build");
    expect(output).toContain("npm run dev");
    expect(output).toContain("npm run test");
  });
});

describe("project: cross-ecosystem detection", () => {
  it("formatProjectDetection handles PHP project", () => {
    const output = formatProjectDetection([{
      type: "PHP (Composer)",
      packageManager: "composer",
      installCmd: "composer install",
      updateCmd: "composer update",
      configFile: "composer.json",
      lockFile: "composer.lock",
    }]);
    expect(output).toContain("PHP");
    expect(output).toContain("composer install");
  });

  it("formatProjectDetection handles Python project", () => {
    const output = formatProjectDetection([{
      type: "Python (Poetry)",
      packageManager: "poetry",
      installCmd: "poetry install",
      updateCmd: "poetry update",
      configFile: "pyproject.toml",
      lockFile: "poetry.lock",
    }]);
    expect(output).toContain("Python");
    expect(output).toContain("poetry install");
  });

  it("formatProjectDetection handles Rust project", () => {
    const output = formatProjectDetection([{
      type: "Rust",
      packageManager: "cargo",
      installCmd: "cargo build",
      updateCmd: "cargo update",
      buildCmd: "cargo build --release",
      configFile: "Cargo.toml",
      lockFile: "Cargo.lock",
    }]);
    expect(output).toContain("Rust");
    expect(output).toContain("cargo build");
  });
});
