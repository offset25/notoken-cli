/**
 * Project scanner.
 *
 * Scans a directory tree to find and describe software projects.
 * Also lists directory contents with rich output.
 *
 * Used by:
 *   "what projects do I have here?"
 *   "where are my files?"
 *   "what's in this folder?"
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { resolve, basename, relative, extname } from "node:path";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
};

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ProjectInfo {
  path: string;
  name: string;
  type: string;
  description?: string;
  version?: string;
  deps?: number;
  scripts?: string[];
  indicators: string[];
}

export interface DirSummary {
  path: string;
  totalFiles: number;
  totalDirs: number;
  projects: ProjectInfo[];
  fileCounts: Record<string, number>;
  largestFiles: Array<{ name: string; size: number }>;
  notable: string[];
  totalSize: number;
}

// ─── Project Signatures ────────────────────────────────────────────────────

interface ProjectSig {
  type: string;
  marker: string;
  parseInfo?: (dir: string) => Partial<ProjectInfo>;
}

const SIGNATURES: ProjectSig[] = [
  {
    type: "Next.js", marker: "next.config",
    parseInfo: (dir) => parsePackageJson(dir, "Next.js"),
  },
  {
    type: "Nuxt.js", marker: "nuxt.config",
    parseInfo: (dir) => parsePackageJson(dir, "Nuxt.js"),
  },
  {
    type: "SvelteKit", marker: "svelte.config.js",
    parseInfo: (dir) => parsePackageJson(dir, "SvelteKit"),
  },
  {
    type: "React", marker: "src/App.tsx",
    parseInfo: (dir) => parsePackageJson(dir, "React"),
  },
  {
    type: "Electron", marker: "electron-builder",
    parseInfo: (dir) => parsePackageJson(dir, "Electron"),
  },
  {
    type: "Node.js", marker: "package.json",
    parseInfo: (dir) => parsePackageJson(dir, "Node.js"),
  },
  {
    type: "Python", marker: "requirements.txt",
    parseInfo: (dir) => {
      try {
        const reqs = readFileSync(resolve(dir, "requirements.txt"), "utf-8");
        return { deps: reqs.split("\n").filter(l => l.trim() && !l.startsWith("#")).length };
      } catch { return {}; }
    },
  },
  { type: "Python", marker: "pyproject.toml" },
  { type: "Django", marker: "manage.py" },
  { type: "Go", marker: "go.mod" },
  { type: "Rust", marker: "Cargo.toml" },
  { type: "Java/Maven", marker: "pom.xml" },
  { type: "Java/Gradle", marker: "build.gradle" },
  { type: "PHP", marker: "composer.json" },
  { type: "Laravel", marker: "artisan" },
  { type: "WordPress", marker: "wp-config.php" },
  { type: "Ruby", marker: "Gemfile" },
  { type: ".NET", marker: "*.csproj" },
  { type: "Terraform", marker: "main.tf" },
  { type: "Docker", marker: "Dockerfile" },
];

function parsePackageJson(dir: string, defaultType: string): Partial<ProjectInfo> {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8"));
    const depCount = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 8);

    // Detect more specific type from deps
    let type = defaultType;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps["next"]) type = "Next.js";
    else if (allDeps["nuxt"]) type = "Nuxt.js";
    else if (allDeps["svelte"]) type = "SvelteKit";
    else if (allDeps["electron"]) type = "Electron";
    else if (allDeps["react"]) type = "React";
    else if (allDeps["vue"]) type = "Vue.js";
    else if (allDeps["@angular/core"]) type = "Angular";
    else if (allDeps["express"]) type = "Express";
    else if (allDeps["fastify"]) type = "Fastify";

    return {
      name: pkg.name,
      type,
      description: pkg.description,
      version: pkg.version,
      deps: depCount,
      scripts,
    };
  } catch { return {}; }
}

// ─── Scanning ──────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "__pycache__",
  "venv", ".venv", "target", "dist", "build", ".cache",
  "vendor", "obj", "bin", ".terraform", ".svelte-kit",
]);

/**
 * Scan for projects in a directory (recursive, up to maxDepth).
 */
export function scanProjects(rootPath: string, maxDepth = 3): ProjectInfo[] {
  const root = resolve(rootPath);
  if (!existsSync(root)) return [];

  const projects: ProjectInfo[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch { return; }

    // Check each signature against this directory
    for (const sig of SIGNATURES) {
      const markerFile = sig.marker;
      let matched = false;

      if (markerFile.startsWith("*")) {
        const ext = markerFile.slice(1);
        matched = entries.some(e => e.endsWith(ext));
      } else if (markerFile.includes("/")) {
        matched = existsSync(resolve(dir, markerFile));
      } else if (markerFile === "electron-builder") {
        // Special: check package.json for electron-builder
        try {
          const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8"));
          matched = !!(pkg.devDependencies?.["electron-builder"] || pkg.build?.appId);
        } catch { matched = false; }
      } else {
        // Check exact filename or prefix match (e.g. "next.config" matches next.config.js/ts/mjs)
        if (markerFile.includes(".")) {
          matched = entries.includes(markerFile);
        } else {
          matched = entries.some(e => e.startsWith(markerFile + ".") || e === markerFile);
        }
      }

      if (matched && !seen.has(dir)) {
        seen.add(dir);
        const info: ProjectInfo = {
          path: dir,
          name: basename(dir),
          type: sig.type,
          indicators: [markerFile],
          ...sig.parseInfo?.(dir),
        };
        projects.push(info);
        break; // One detection per directory
      }
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = resolve(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          walk(full, depth + 1);
        }
      } catch {}
    }
  }

  walk(root, 0);
  return projects;
}

/**
 * Summarize a directory — files, projects, sizes.
 */
export function summarizeDirectory(dirPath: string): DirSummary {
  const root = resolve(dirPath);
  let totalFiles = 0;
  let totalDirs = 0;
  let totalSize = 0;
  const fileCounts: Record<string, number> = {};
  const largestFiles: Array<{ name: string; size: number }> = [];
  const notable: string[] = [];

  const NOTABLE = new Set([
    "README.md", "LICENSE", "Dockerfile", "docker-compose.yml",
    ".env", "Makefile", ".gitignore", "package.json", "tsconfig.json",
    "requirements.txt", "go.mod", "Cargo.toml",
  ]);

  try {
    const entries = readdirSync(root);
    for (const entry of entries) {
      const full = resolve(root, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          totalDirs++;
        } else {
          totalFiles++;
          totalSize += stat.size;
          const ext = extname(entry).toLowerCase() || "(no ext)";
          fileCounts[ext] = (fileCounts[ext] ?? 0) + 1;
          largestFiles.push({ name: entry, size: stat.size });
        }
        if (NOTABLE.has(entry)) notable.push(entry);
      } catch {}
    }
  } catch {}

  largestFiles.sort((a, b) => b.size - a.size);

  const projects = scanProjects(root, 2);

  return {
    path: root,
    totalFiles,
    totalDirs,
    projects,
    fileCounts,
    largestFiles: largestFiles.slice(0, 5),
    notable,
    totalSize,
  };
}

// ─── Formatting ────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${(bytes / 1073741824).toFixed(1)}GB`;
}

export function formatProjectList(projects: ProjectInfo[], rootPath: string): string {
  if (projects.length === 0) {
    return `${c.dim}No projects found in ${rootPath}${c.reset}`;
  }

  const lines: string[] = [];
  const root = resolve(rootPath);
  lines.push(`${c.bold}Projects in ${root}${c.reset}\n`);

  for (const p of projects) {
    const rel = relative(root, p.path) || ".";
    const ver = p.version ? ` ${c.dim}v${p.version}${c.reset}` : "";
    const deps = p.deps ? ` ${c.dim}(${p.deps} deps)${c.reset}` : "";
    lines.push(`  ${c.magenta}${p.type}${c.reset} ${c.bold}${p.name}${c.reset}${ver}${deps}`);
    if (p.description) lines.push(`    ${c.dim}${p.description}${c.reset}`);
    if (rel !== ".") lines.push(`    ${c.dim}${rel}/${c.reset}`);
    if (p.scripts && p.scripts.length > 0) {
      lines.push(`    ${c.dim}scripts: ${p.scripts.join(", ")}${c.reset}`);
    }
  }

  lines.push(`\n  ${c.dim}${projects.length} project(s) found${c.reset}`);
  return lines.join("\n");
}

export function formatDirSummary(summary: DirSummary): string {
  const lines: string[] = [];
  lines.push(`${c.bold}${summary.path}${c.reset}\n`);
  lines.push(`  ${c.cyan}${summary.totalFiles}${c.reset} file(s), ${c.cyan}${summary.totalDirs}${c.reset} director${summary.totalDirs === 1 ? "y" : "ies"} — ${formatSize(summary.totalSize)} total`);

  // File type breakdown
  const sorted = Object.entries(summary.fileCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (sorted.length > 0) {
    lines.push(`\n  ${c.bold}File types:${c.reset}`);
    for (const [ext, count] of sorted) {
      const bar = "█".repeat(Math.min(15, Math.round((count / summary.totalFiles) * 15)));
      lines.push(`    ${c.dim}${bar}${c.reset} ${ext}: ${count}`);
    }
  }

  // Largest files
  if (summary.largestFiles.length > 0) {
    lines.push(`\n  ${c.bold}Largest files:${c.reset}`);
    for (const f of summary.largestFiles) {
      lines.push(`    ${formatSize(f.size).padStart(8)} ${f.name}`);
    }
  }

  // Notable files
  if (summary.notable.length > 0) {
    lines.push(`\n  ${c.bold}Notable:${c.reset} ${summary.notable.join(", ")}`);
  }

  // Projects
  if (summary.projects.length > 0) {
    lines.push(`\n  ${c.bold}Projects detected:${c.reset}`);
    for (const p of summary.projects) {
      const rel = relative(summary.path, p.path) || ".";
      const ver = p.version ? ` v${p.version}` : "";
      lines.push(`    ${c.magenta}${p.type}${c.reset} ${p.name}${c.dim}${ver}${c.reset}${rel !== "." ? ` ${c.dim}(${rel}/)${c.reset}` : ""}`);
    }
  }

  return lines.join("\n");
}
