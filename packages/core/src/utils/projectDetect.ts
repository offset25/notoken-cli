/**
 * Smart project detection and package manager resolution.
 *
 * Detects the project type in a directory and returns the correct
 * install/update/build commands for that project's ecosystem.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectLocalPlatform } from "./platform.js";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};

export interface DetectedProject {
  type: string;
  packageManager: string;
  installCmd: string;
  updateCmd: string;
  buildCmd?: string;
  lockFile?: string;
  configFile: string;
}

/** Check which files exist in a directory. */
function has(dir: string, ...files: string[]): boolean {
  return files.some((f) => existsSync(resolve(dir, f)));
}

/**
 * Detect all projects in a directory.
 * Returns them in priority order (most specific first).
 */
export function detectProjects(dir: string = process.cwd()): DetectedProject[] {
  const projects: DetectedProject[] = [];

  // ── Node.js ecosystem ──
  if (has(dir, "package.json")) {
    // Detect which package manager
    let pm = "npm";
    let installCmd = "npm install";
    let updateCmd = "npm update";
    let lockFile: string | undefined;

    if (has(dir, "bun.lockb", "bun.lock")) {
      pm = "bun";
      installCmd = "bun install";
      updateCmd = "bun update";
      lockFile = "bun.lockb";
    } else if (has(dir, "pnpm-lock.yaml")) {
      pm = "pnpm";
      installCmd = "pnpm install";
      updateCmd = "pnpm update";
      lockFile = "pnpm-lock.yaml";
    } else if (has(dir, "yarn.lock")) {
      pm = "yarn";
      installCmd = "yarn install";
      updateCmd = "yarn upgrade";
      lockFile = "yarn.lock";
    } else if (has(dir, "package-lock.json")) {
      lockFile = "package-lock.json";
    }

    // Detect framework for type label
    let type = "Node.js";
    if (has(dir, "next.config.js", "next.config.ts", "next.config.mjs")) type = "Next.js";
    else if (has(dir, "nuxt.config.ts", "nuxt.config.js")) type = "Nuxt.js";
    else if (has(dir, "svelte.config.js")) type = "SvelteKit";
    else if (has(dir, "remix.config.js")) type = "Remix";
    else if (has(dir, "astro.config.mjs")) type = "Astro";
    else if (has(dir, "angular.json")) type = "Angular";
    else if (has(dir, "vue.config.js")) type = "Vue.js";
    else if (has(dir, "tsconfig.json")) type = "TypeScript/Node.js";

    const buildCmd = has(dir, "tsconfig.json") ? `${pm} run build` : undefined;

    projects.push({ type, packageManager: pm, installCmd, updateCmd, buildCmd, lockFile, configFile: "package.json" });
  }

  // ── Python ecosystem ──
  if (has(dir, "pyproject.toml")) {
    if (has(dir, "poetry.lock")) {
      projects.push({ type: "Python (Poetry)", packageManager: "poetry", installCmd: "poetry install", updateCmd: "poetry update", configFile: "pyproject.toml", lockFile: "poetry.lock" });
    } else if (has(dir, "uv.lock")) {
      projects.push({ type: "Python (uv)", packageManager: "uv", installCmd: "uv sync", updateCmd: "uv lock --upgrade && uv sync", configFile: "pyproject.toml", lockFile: "uv.lock" });
    } else if (has(dir, "pdm.lock")) {
      projects.push({ type: "Python (pdm)", packageManager: "pdm", installCmd: "pdm install", updateCmd: "pdm update", configFile: "pyproject.toml", lockFile: "pdm.lock" });
    } else {
      projects.push({ type: "Python", packageManager: "pip", installCmd: "pip install -e .", updateCmd: "pip install -e . --upgrade", configFile: "pyproject.toml" });
    }
  } else if (has(dir, "Pipfile")) {
    projects.push({ type: "Python (Pipenv)", packageManager: "pipenv", installCmd: "pipenv install", updateCmd: "pipenv update", configFile: "Pipfile", lockFile: "Pipfile.lock" });
  } else if (has(dir, "requirements.txt")) {
    projects.push({ type: "Python", packageManager: "pip", installCmd: "pip install -r requirements.txt", updateCmd: "pip install -r requirements.txt --upgrade", configFile: "requirements.txt" });
  }

  // ── Go ──
  if (has(dir, "go.mod")) {
    projects.push({ type: "Go", packageManager: "go", installCmd: "go mod download", updateCmd: "go get -u ./... && go mod tidy", configFile: "go.mod", lockFile: "go.sum" });
  }

  // ── Rust ──
  if (has(dir, "Cargo.toml")) {
    projects.push({ type: "Rust", packageManager: "cargo", installCmd: "cargo build", updateCmd: "cargo update", buildCmd: "cargo build --release", configFile: "Cargo.toml", lockFile: "Cargo.lock" });
  }

  // ── Ruby ──
  if (has(dir, "Gemfile")) {
    projects.push({ type: "Ruby", packageManager: "bundler", installCmd: "bundle install", updateCmd: "bundle update", configFile: "Gemfile", lockFile: "Gemfile.lock" });
  }

  // ── PHP ──
  if (has(dir, "composer.json")) {
    projects.push({ type: "PHP (Composer)", packageManager: "composer", installCmd: "composer install", updateCmd: "composer update", configFile: "composer.json", lockFile: "composer.lock" });
  }

  // ── .NET ──
  const csproj = ["*.csproj", "*.fsproj"].some(() => {
    try {
      const { execSync } = require("node:child_process");
      return execSync(`ls ${dir}/*.csproj ${dir}/*.fsproj 2>/dev/null`, { encoding: "utf-8" }).trim().length > 0;
    } catch { return false; }
  });
  if (has(dir, "*.sln") || csproj) {
    projects.push({ type: ".NET", packageManager: "dotnet", installCmd: "dotnet restore", updateCmd: "dotnet restore", buildCmd: "dotnet build", configFile: "*.csproj" });
  }

  // ── Java ──
  if (has(dir, "pom.xml")) {
    projects.push({ type: "Java (Maven)", packageManager: "maven", installCmd: "mvn install", updateCmd: "mvn versions:use-latest-versions", buildCmd: "mvn package", configFile: "pom.xml" });
  } else if (has(dir, "build.gradle", "build.gradle.kts")) {
    projects.push({ type: "Java (Gradle)", packageManager: "gradle", installCmd: "./gradlew build", updateCmd: "./gradlew dependencies --write-locks", buildCmd: "./gradlew build", configFile: "build.gradle" });
  }

  return projects;
}

/** Format project detection results for display. */
export function formatProjectDetection(projects: DetectedProject[]): string {
  if (projects.length === 0) {
    return `${c.dim}No recognized projects in current directory.${c.reset}`;
  }

  const lines: string[] = [];
  lines.push(`\n${c.bold}${c.cyan}── Detected Projects ──${c.reset}\n`);

  for (const p of projects) {
    const lockLabel = p.lockFile && existsSync(resolve(process.cwd(), p.lockFile))
      ? `${c.green}✓${c.reset} ${p.lockFile}`
      : `${c.yellow}⚠ no lock file${c.reset}`;
    lines.push(`  ${c.magenta}${c.bold}${p.type}${c.reset}  ${c.dim}(${p.packageManager})${c.reset}  ${lockLabel}`);
    lines.push(`    Install: ${c.cyan}${p.installCmd}${c.reset}`);
    lines.push(`    Update:  ${c.cyan}${p.updateCmd}${c.reset}`);
    if (p.buildCmd) {
      lines.push(`    Build:   ${c.cyan}${p.buildCmd}${c.reset}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Get the install command for the primary project in cwd. */
export function getProjectInstallCmd(dir?: string): string | null {
  const projects = detectProjects(dir);
  return projects.length > 0 ? projects[0].installCmd : null;
}

/** Get the update command for the primary project in cwd. */
export function getProjectUpdateCmd(dir?: string): string | null {
  const projects = detectProjects(dir);
  return projects.length > 0 ? projects[0].updateCmd : null;
}

// ─── Package.json script detection ───────────────────────────────────────────

export interface ProjectScripts {
  packageManager: string;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  name: string;
  version: string;
}

/** Read package.json or composer.json and extract scripts, deps, and metadata. */
export function readProjectConfig(dir: string = process.cwd()): ProjectScripts | null {
  // Try package.json first (Node.js)
  if (existsSync(resolve(dir, "package.json"))) {
    return readPackageJson(dir);
  }
  // Try composer.json (PHP)
  if (existsSync(resolve(dir, "composer.json"))) {
    return readComposerJson(dir);
  }
  // Try pyproject.toml scripts
  if (existsSync(resolve(dir, "pyproject.toml"))) {
    return readPyprojectScripts(dir);
  }
  return null;
}

function readPackageJson(dir: string): ProjectScripts | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8"));
    let pm = "npm";
    if (existsSync(resolve(dir, "bun.lockb")) || existsSync(resolve(dir, "bun.lock"))) pm = "bun";
    else if (existsSync(resolve(dir, "pnpm-lock.yaml"))) pm = "pnpm";
    else if (existsSync(resolve(dir, "yarn.lock"))) pm = "yarn";

    return {
      packageManager: pm,
      scripts: pkg.scripts ?? {},
      dependencies: Object.keys(pkg.dependencies ?? {}),
      devDependencies: Object.keys(pkg.devDependencies ?? {}),
      name: pkg.name ?? "unknown",
      version: pkg.version ?? "0.0.0",
    };
  } catch {
    return null;
  }
}

function readComposerJson(dir: string): ProjectScripts | null {
  try {
    const composer = JSON.parse(readFileSync(resolve(dir, "composer.json"), "utf-8"));
    return {
      packageManager: "composer",
      scripts: composer.scripts ?? {},
      dependencies: Object.keys(composer.require ?? {}),
      devDependencies: Object.keys(composer["require-dev"] ?? {}),
      name: composer.name ?? "unknown",
      version: composer.version ?? "0.0.0",
    };
  } catch {
    return null;
  }
}

function readPyprojectScripts(dir: string): ProjectScripts | null {
  try {
    const content = readFileSync(resolve(dir, "pyproject.toml"), "utf-8");
    // Basic TOML script extraction — look for [tool.poetry.scripts] or [project.scripts]
    const scripts: Record<string, string> = {};
    const scriptMatch = content.match(/\[(?:tool\.poetry\.scripts|project\.scripts)\]\n([\s\S]*?)(?:\n\[|$)/);
    if (scriptMatch) {
      for (const line of scriptMatch[1].split("\n")) {
        const kv = line.match(/^(\w[\w-]*)\s*=\s*"([^"]+)"/);
        if (kv) scripts[kv[1]] = kv[2];
      }
    }

    const pm = existsSync(resolve(dir, "poetry.lock")) ? "poetry"
      : existsSync(resolve(dir, "uv.lock")) ? "uv"
      : "pip";

    // Extract project name
    const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
    const versionMatch = content.match(/version\s*=\s*"([^"]+)"/);

    return {
      packageManager: pm,
      scripts,
      dependencies: [],
      devDependencies: [],
      name: nameMatch?.[1] ?? "unknown",
      version: versionMatch?.[1] ?? "0.0.0",
    };
  } catch {
    return null;
  }
}

/** Format package.json scripts for display. */
export function formatPackageScripts(info: ProjectScripts): string {
  const lines: string[] = [];
  const scripts = Object.entries(info.scripts);

  lines.push(`\n${c.bold}${c.cyan}── ${info.name}@${info.version} ──${c.reset}\n`);
  lines.push(`  ${c.bold}Package manager:${c.reset} ${info.packageManager}`);

  if (scripts.length > 0) {
    lines.push(`\n  ${c.bold}Available scripts:${c.reset}`);
    for (const [name, cmd] of scripts) {
      const runCmd = info.packageManager === "npm" ? `npm run ${name}` : `${info.packageManager} ${name}`;
      lines.push(`    ${c.cyan}${runCmd.padEnd(30)}${c.reset} ${c.dim}→ ${cmd}${c.reset}`);
    }
  } else {
    lines.push(`  ${c.dim}No scripts defined.${c.reset}`);
  }

  if (info.dependencies.length > 0) {
    lines.push(`\n  ${c.bold}Dependencies:${c.reset} ${c.dim}(${info.dependencies.length})${c.reset}`);
    const shown = info.dependencies.slice(0, 10);
    lines.push(`    ${c.dim}${shown.join(", ")}${info.dependencies.length > 10 ? ` +${info.dependencies.length - 10} more` : ""}${c.reset}`);
  }

  if (info.devDependencies.length > 0) {
    lines.push(`  ${c.bold}Dev dependencies:${c.reset} ${c.dim}(${info.devDependencies.length})${c.reset}`);
    const shown = info.devDependencies.slice(0, 10);
    lines.push(`    ${c.dim}${shown.join(", ")}${info.devDependencies.length > 10 ? ` +${info.devDependencies.length - 10} more` : ""}${c.reset}`);
  }

  return lines.join("\n");
}

/** Build the run command prefix for a package manager. */
function runPrefix(pm: string, script: string): string {
  switch (pm) {
    case "npm": return `npm run ${script}`;
    case "composer": return `composer ${script}`;
    case "poetry": return `poetry run ${script}`;
    case "uv": return `uv run ${script}`;
    default: return `${pm} ${script}`;
  }
}

/** Get the run command for a named script. */
export function getScriptRunCmd(scriptName: string, dir?: string): string | null {
  const info = readProjectConfig(dir);
  if (!info) return null;

  // Exact match
  if (info.scripts[scriptName]) {
    return runPrefix(info.packageManager, scriptName);
  }

  // Fuzzy match — "dev" matches "dev", "start:dev", etc.
  const fuzzy = Object.keys(info.scripts).find((s) =>
    s === scriptName || s.includes(scriptName) || scriptName.includes(s)
  );
  if (fuzzy) {
    return runPrefix(info.packageManager, fuzzy);
  }

  return null;
}

/**
 * Get the system-level update command based on the detected platform.
 */
export function getSystemUpdateCmd(): string {
  const plat = detectLocalPlatform();
  switch (plat.packageManager) {
    case "apt": return "sudo apt-get update && sudo apt-get upgrade -y";
    case "dnf": return "sudo dnf upgrade -y";
    case "yum": return "sudo yum update -y";
    case "pacman": return "sudo pacman -Syu --noconfirm";
    case "apk": return "sudo apk update && sudo apk upgrade";
    case "brew": return "brew update && brew upgrade";
    case "choco": return "choco upgrade all -y";
    default: return "echo 'Unknown package manager — update manually'";
  }
}
