/**
 * Directory analysis.
 *
 * When listing files in a directory, detects:
 * - Project type (Node.js, Next.js, Python, PHP, WordPress, Laravel, Go, Rust, etc.)
 * - File type breakdown (code, config, data, logs, images, etc.)
 * - Notable files (README, Dockerfile, CI configs, env files)
 * - Directory size assessment
 */

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

export interface ProjectDetection {
  type: string;
  confidence: number;
  indicators: string[];
}

export interface FileTypeBreakdown {
  category: string;
  count: number;
  extensions: string[];
}

// ─── Project Detection ───────────────────────────────────────────────────────

const PROJECT_SIGNATURES: Array<{
  name: string;
  files: string[];
  dirs: string[];
  priority: number;
}> = [
  { name: "Next.js", files: ["next.config.js", "next.config.ts", "next.config.mjs"], dirs: [".next"], priority: 10 },
  { name: "Nuxt.js", files: ["nuxt.config.ts", "nuxt.config.js"], dirs: [".nuxt"], priority: 10 },
  { name: "SvelteKit", files: ["svelte.config.js"], dirs: [], priority: 10 },
  { name: "Remix", files: ["remix.config.js"], dirs: [], priority: 10 },
  { name: "Astro", files: ["astro.config.mjs"], dirs: [], priority: 10 },
  { name: "React (CRA)", files: ["react-scripts"], dirs: [], priority: 8 },
  { name: "Vue.js", files: ["vue.config.js"], dirs: [], priority: 8 },
  { name: "Angular", files: ["angular.json"], dirs: [], priority: 8 },
  { name: "Node.js", files: ["package.json"], dirs: ["node_modules"], priority: 5 },
  { name: "TypeScript", files: ["tsconfig.json"], dirs: [], priority: 4 },
  { name: "Deno", files: ["deno.json", "deno.jsonc"], dirs: [], priority: 8 },
  { name: "Bun", files: ["bunfig.toml"], dirs: [], priority: 8 },
  { name: "Python", files: ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"], dirs: ["__pycache__", "venv", ".venv"], priority: 5 },
  { name: "Django", files: ["manage.py"], dirs: [], priority: 8 },
  { name: "Flask", files: ["app.py", "wsgi.py"], dirs: [], priority: 6 },
  { name: "FastAPI", files: ["main.py"], dirs: [], priority: 5 },
  { name: "PHP", files: ["composer.json", "index.php"], dirs: ["vendor"], priority: 5 },
  { name: "WordPress", files: ["wp-config.php", "wp-login.php"], dirs: ["wp-content", "wp-admin", "wp-includes"], priority: 10 },
  { name: "Laravel", files: ["artisan"], dirs: ["app", "bootstrap", "routes"], priority: 9 },
  { name: "Symfony", files: ["symfony.lock"], dirs: ["src", "config"], priority: 8 },
  { name: "Go", files: ["go.mod", "go.sum"], dirs: [], priority: 7 },
  { name: "Rust", files: ["Cargo.toml", "Cargo.lock"], dirs: ["target"], priority: 7 },
  { name: "Java/Maven", files: ["pom.xml"], dirs: ["src/main"], priority: 7 },
  { name: "Java/Gradle", files: ["build.gradle", "build.gradle.kts"], dirs: [], priority: 7 },
  { name: "Ruby on Rails", files: ["Gemfile", "Rakefile"], dirs: ["app", "config", "db"], priority: 7 },
  { name: "Ruby", files: ["Gemfile"], dirs: [], priority: 4 },
  { name: ".NET/C#", files: ["*.csproj", "*.sln"], dirs: ["bin", "obj"], priority: 7 },
  { name: "Docker project", files: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml"], dirs: [], priority: 3 },
  { name: "Terraform", files: ["main.tf", "terraform.tfstate"], dirs: [".terraform"], priority: 8 },
  { name: "Ansible", files: ["ansible.cfg", "playbook.yml"], dirs: ["roles"], priority: 8 },
  { name: "Shell scripts", files: ["*.sh"], dirs: [], priority: 2 },
  { name: "Batch scripts", files: ["*.bat", "*.cmd", "*.ps1"], dirs: [], priority: 2 },
];

// ─── File Categories ─────────────────────────────────────────────────────────

const FILE_CATEGORIES: Record<string, string[]> = {
  "Code": [".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".cs", ".php", ".swift", ".kt"],
  "Config": [".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env", ".xml"],
  "Web": [".html", ".htm", ".css", ".scss", ".sass", ".less", ".svg"],
  "Data": [".csv", ".sql", ".db", ".sqlite", ".parquet"],
  "Documents": [".md", ".txt", ".doc", ".docx", ".pdf", ".rtf"],
  "Images": [".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico", ".bmp", ".tiff"],
  "Archives": [".zip", ".tar", ".gz", ".bz2", ".xz", ".rar", ".7z"],
  "Logs": [".log"],
  "Scripts": [".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1"],
  "Build": [".o", ".class", ".pyc", ".wasm"],
};

const NOTABLE_FILES = new Set([
  "README.md", "README", "LICENSE", "CHANGELOG.md",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  ".env", ".env.local", ".env.production",
  ".gitignore", ".dockerignore", ".editorconfig",
  "Makefile", "Procfile", "Vagrantfile",
  ".github", ".gitlab-ci.yml", "Jenkinsfile",
  "package.json", "tsconfig.json", "requirements.txt",
]);

/**
 * Analyze ls -la output and return commentary.
 */
export function analyzeDirectory(output: string): string {
  const lines: string[] = [];
  const entries = parseLsOutput(output);

  if (entries.length === 0) return "";

  const files = entries.filter((e) => e.type === "file");
  const dirs = entries.filter((e) => e.type === "directory");
  const fileNames = files.map((e) => e.name);
  const dirNames = dirs.map((e) => e.name);
  const allNames = [...fileNames, ...dirNames];

  lines.push(`\n${c.bold}${c.cyan}── Analysis ──${c.reset}`);
  lines.push(`  ${files.length} file(s), ${dirs.length} directory(ies)`);

  // Detect project type
  const detected = detectProjects(fileNames, dirNames);
  if (detected.length > 0) {
    lines.push(`\n  ${c.bold}Project detected:${c.reset}`);
    for (const d of detected) {
      lines.push(`  ${c.magenta}${d.type}${c.reset} — ${d.indicators.join(", ")}`);
    }
  }

  // File type breakdown
  const breakdown = categorizeFiles(fileNames);
  if (breakdown.length > 0) {
    lines.push(`\n  ${c.bold}File types:${c.reset}`);
    for (const b of breakdown.slice(0, 6)) {
      const bar = "█".repeat(Math.min(20, Math.round((b.count / files.length) * 20)));
      lines.push(`  ${c.dim}${bar}${c.reset} ${b.category}: ${b.count} (${b.extensions.join(", ")})`);
    }
  }

  // Notable files
  const notable = allNames.filter((n) => NOTABLE_FILES.has(n));
  if (notable.length > 0) {
    lines.push(`\n  ${c.bold}Notable:${c.reset} ${notable.join(", ")}`);
  }

  // Warnings
  if (dirNames.includes("node_modules")) {
    lines.push(`  ${c.yellow}⚠ node_modules present — may be large${c.reset}`);
  }
  if (fileNames.some((f) => f === ".env" || f.startsWith(".env."))) {
    lines.push(`  ${c.yellow}⚠ .env file(s) present — check they're in .gitignore${c.reset}`);
  }

  return lines.join("\n");
}

function detectProjects(files: string[], dirs: string[]): ProjectDetection[] {
  const results: ProjectDetection[] = [];

  for (const sig of PROJECT_SIGNATURES) {
    const matchedFiles = sig.files.filter((f) => {
      if (f.startsWith("*")) {
        const ext = f.slice(1);
        return files.some((name) => name.endsWith(ext));
      }
      return files.includes(f);
    });

    const matchedDirs = sig.dirs.filter((d) => dirs.includes(d));

    if (matchedFiles.length > 0 || matchedDirs.length > 0) {
      results.push({
        type: sig.name,
        confidence: sig.priority / 10,
        indicators: [...matchedFiles, ...matchedDirs.map((d) => `${d}/`)],
      });
    }
  }

  // Sort by priority, take top 3
  results.sort((a, b) => b.confidence - a.confidence);
  return results.slice(0, 3);
}

function categorizeFiles(files: string[]): FileTypeBreakdown[] {
  const counts = new Map<string, { count: number; extensions: Set<string> }>();

  for (const file of files) {
    const dot = file.lastIndexOf(".");
    const ext = dot >= 0 ? file.slice(dot).toLowerCase() : "";

    let category = "Other";
    for (const [cat, exts] of Object.entries(FILE_CATEGORIES)) {
      if (exts.includes(ext)) {
        category = cat;
        break;
      }
    }

    const entry = counts.get(category) ?? { count: 0, extensions: new Set<string>() };
    entry.count++;
    if (ext) entry.extensions.add(ext);
    counts.set(category, entry);
  }

  return Array.from(counts.entries())
    .map(([category, { count, extensions }]) => ({
      category,
      count,
      extensions: Array.from(extensions).slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count);
}

interface LsEntry {
  type: "file" | "directory" | "symlink" | "other";
  permissions: string;
  name: string;
  size: string;
}

function parseLsOutput(output: string): LsEntry[] {
  const entries: LsEntry[] = [];

  for (const line of output.split("\n")) {
    // Match: drwxr-xr-x  2 root root 4096 Jan 1 12:00 dirname
    // Match: -rw-r--r--  1 root root 1234 Jan 1 12:00 filename
    const match = line.match(/^([dlcbsp-])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\d+\s+[\d:]+\s+(.+)$/);
    if (!match) continue;

    const typeChar = match[1];
    const name = match[4].trim();
    if (name === "." || name === "..") continue;

    entries.push({
      type: typeChar === "d" ? "directory" : typeChar === "l" ? "symlink" : typeChar === "-" ? "file" : "other",
      permissions: match[1] + match[2],
      name,
      size: match[3],
    });
  }

  return entries;
}
