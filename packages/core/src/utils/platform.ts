/**
 * OS/distro/platform detection.
 *
 * Detects:
 * - Linux distro (Ubuntu, Debian, CentOS, RHEL, Fedora, Arch, Alpine, Amazon Linux)
 * - macOS
 * - Windows (PowerShell, cmd, WSL)
 * - Package manager (apt, dnf, yum, pacman, apk, brew, choco)
 * - Init system (systemd, sysvinit, openrc)
 * - Shell (bash, zsh, fish, powershell, cmd)
 *
 * Works locally and remotely via SSH.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform as osPlatform, release as osRelease } from "node:os";

export interface PlatformInfo {
  os: "linux" | "darwin" | "windows" | "unknown";
  distro: string;
  distroVersion: string;
  distroFamily: "debian" | "rhel" | "arch" | "alpine" | "macos" | "windows" | "unknown";
  kernel: string;
  isWSL: boolean;
  shell: string;
  packageManager: "apt" | "dnf" | "yum" | "pacman" | "apk" | "brew" | "choco" | "unknown";
  initSystem: "systemd" | "sysvinit" | "openrc" | "launchd" | "unknown";
  arch: string;
}

let cachedLocal: PlatformInfo | null = null;

/**
 * Detect the local platform.
 */
export function detectLocalPlatform(): PlatformInfo {
  if (cachedLocal) return cachedLocal;

  const os = osPlatform();

  if (os === "win32") {
    cachedLocal = detectWindows();
  } else if (os === "darwin") {
    cachedLocal = detectMacOS();
  } else {
    cachedLocal = detectLinux();
  }

  return cachedLocal;
}

function detectLinux(): PlatformInfo {
  const kernel = osRelease();
  const isWSL = kernel.toLowerCase().includes("microsoft") || kernel.toLowerCase().includes("wsl");
  const arch = tryExec("uname -m") ?? "unknown";
  const shell = process.env.SHELL ?? "unknown";

  // Read /etc/os-release for distro info
  let distro = "unknown";
  let distroVersion = "";
  let distroFamily: PlatformInfo["distroFamily"] = "unknown";

  if (existsSync("/etc/os-release")) {
    const content = readFileSync("/etc/os-release", "utf-8");
    distro = extractField(content, "PRETTY_NAME") ?? extractField(content, "NAME") ?? "unknown";
    distroVersion = extractField(content, "VERSION_ID") ?? "";
    const id = (extractField(content, "ID") ?? "").toLowerCase();
    const idLike = (extractField(content, "ID_LIKE") ?? "").toLowerCase();

    if (id === "ubuntu" || id === "debian" || idLike.includes("debian")) {
      distroFamily = "debian";
    } else if (id === "centos" || id === "rhel" || id === "fedora" || id === "rocky" || id === "alma" || id === "amzn" || idLike.includes("rhel") || idLike.includes("fedora")) {
      distroFamily = "rhel";
    } else if (id === "arch" || idLike.includes("arch")) {
      distroFamily = "arch";
    } else if (id === "alpine") {
      distroFamily = "alpine";
    }
  }

  // Detect package manager
  let packageManager: PlatformInfo["packageManager"] = "unknown";
  if (commandExists("apt-get")) packageManager = "apt";
  else if (commandExists("dnf")) packageManager = "dnf";
  else if (commandExists("yum")) packageManager = "yum";
  else if (commandExists("pacman")) packageManager = "pacman";
  else if (commandExists("apk")) packageManager = "apk";

  // Detect init system
  let initSystem: PlatformInfo["initSystem"] = "unknown";
  if (existsSync("/run/systemd/system") || commandExists("systemctl")) initSystem = "systemd";
  else if (existsSync("/etc/init.d")) initSystem = "sysvinit";
  else if (commandExists("rc-service")) initSystem = "openrc";

  return {
    os: "linux",
    distro,
    distroVersion,
    distroFamily,
    kernel,
    isWSL,
    shell,
    packageManager,
    initSystem,
    arch,
  };
}

function detectMacOS(): PlatformInfo {
  const version = tryExec("sw_vers -productVersion") ?? "";
  return {
    os: "darwin",
    distro: `macOS ${version}`,
    distroVersion: version,
    distroFamily: "macos",
    kernel: osRelease(),
    isWSL: false,
    shell: process.env.SHELL ?? "zsh",
    packageManager: commandExists("brew") ? "brew" : "unknown",
    initSystem: "launchd",
    arch: tryExec("uname -m") ?? "unknown",
  };
}

function detectWindows(): PlatformInfo {
  const isPS = !!process.env.PSModulePath;
  return {
    os: "windows",
    distro: `Windows ${osRelease()}`,
    distroVersion: osRelease(),
    distroFamily: "windows",
    kernel: osRelease(),
    isWSL: false,
    shell: isPS ? "powershell" : "cmd",
    packageManager: commandExists("choco") ? "choco" : "unknown",
    initSystem: "unknown",
    arch: process.arch,
  };
}

/**
 * Detect platform on a remote host via SSH.
 */
export async function detectRemotePlatform(environment: string): Promise<PlatformInfo> {
  const { runRemoteCommand } = await import("../execution/ssh.js");

  try {
    const osRelease = await runRemoteCommand(environment, "cat /etc/os-release 2>/dev/null || echo 'UNKNOWN'");
    const kernel = (await runRemoteCommand(environment, "uname -r")).trim();
    const arch = (await runRemoteCommand(environment, "uname -m")).trim();
    const shell = (await runRemoteCommand(environment, "echo $SHELL")).trim();

    let distro = "unknown";
    let distroVersion = "";
    let distroFamily: PlatformInfo["distroFamily"] = "unknown";

    if (!osRelease.includes("UNKNOWN")) {
      distro = extractField(osRelease, "PRETTY_NAME") ?? "unknown";
      distroVersion = extractField(osRelease, "VERSION_ID") ?? "";
      const id = (extractField(osRelease, "ID") ?? "").toLowerCase();
      const idLike = (extractField(osRelease, "ID_LIKE") ?? "").toLowerCase();

      if (id === "ubuntu" || id === "debian" || idLike.includes("debian")) distroFamily = "debian";
      else if (["centos", "rhel", "fedora", "rocky", "alma", "amzn"].includes(id) || idLike.includes("rhel")) distroFamily = "rhel";
      else if (id === "arch" || idLike.includes("arch")) distroFamily = "arch";
      else if (id === "alpine") distroFamily = "alpine";
    }

    // Detect package manager remotely
    const pmCheck = await runRemoteCommand(environment,
      "command -v apt-get >/dev/null && echo apt || command -v dnf >/dev/null && echo dnf || command -v yum >/dev/null && echo yum || command -v pacman >/dev/null && echo pacman || command -v apk >/dev/null && echo apk || echo unknown"
    );
    const packageManager = pmCheck.trim() as PlatformInfo["packageManager"];

    const initCheck = await runRemoteCommand(environment,
      "test -d /run/systemd/system && echo systemd || test -d /etc/init.d && echo sysvinit || echo unknown"
    );
    const initSystem = initCheck.trim() as PlatformInfo["initSystem"];

    const isWSL = kernel.toLowerCase().includes("microsoft");

    return { os: "linux", distro, distroVersion, distroFamily, kernel, isWSL, shell, packageManager, initSystem, arch };
  } catch {
    return { os: "unknown", distro: "unknown", distroVersion: "", distroFamily: "unknown", kernel: "", isWSL: false, shell: "", packageManager: "unknown", initSystem: "unknown", arch: "" };
  }
}

/**
 * Get the correct install command for the detected platform.
 */
export function getInstallCommand(pkg: string, platform: PlatformInfo): string {
  switch (platform.packageManager) {
    case "apt": return `sudo apt-get update && sudo apt-get install -y ${pkg}`;
    case "dnf": return `sudo dnf install -y ${pkg}`;
    case "yum": return `sudo yum install -y ${pkg}`;
    case "pacman": return `sudo pacman -S --noconfirm ${pkg}`;
    case "apk": return `sudo apk add ${pkg}`;
    case "brew": return `brew install ${pkg}`;
    case "choco": return `choco install ${pkg} -y`;
    default: return `echo "Cannot determine package manager. Install ${pkg} manually."`;
  }
}

/**
 * Get the correct service management command.
 */
export function getServiceCommand(action: "start" | "stop" | "restart" | "status", service: string, platform: PlatformInfo): string {
  switch (platform.initSystem) {
    case "systemd": return `sudo systemctl ${action} ${service}`;
    case "sysvinit": return `sudo service ${service} ${action}`;
    case "openrc": return `sudo rc-service ${service} ${action}`;
    case "launchd": return action === "status" ? `launchctl list | grep ${service}` : `sudo launchctl ${action === "start" ? "load" : "unload"} /Library/LaunchDaemons/${service}.plist`;
    default: return `sudo systemctl ${action} ${service}`;
  }
}

/**
 * Map common command names to package names per distro family.
 */
export const COMMAND_TO_PACKAGE: Record<string, Record<string, string>> = {
  whois: { debian: "whois", rhel: "whois", arch: "whois", alpine: "whois" },
  dig: { debian: "dnsutils", rhel: "bind-utils", arch: "bind", alpine: "bind-tools" },
  nslookup: { debian: "dnsutils", rhel: "bind-utils", arch: "bind", alpine: "bind-tools" },
  traceroute: { debian: "traceroute", rhel: "traceroute", arch: "traceroute", alpine: "traceroute" },
  rsync: { debian: "rsync", rhel: "rsync", arch: "rsync", alpine: "rsync" },
  zip: { debian: "zip", rhel: "zip", arch: "zip", alpine: "zip" },
  unzip: { debian: "unzip", rhel: "unzip", arch: "unzip", alpine: "unzip" },
  curl: { debian: "curl", rhel: "curl", arch: "curl", alpine: "curl" },
  wget: { debian: "wget", rhel: "wget", arch: "wget", alpine: "wget" },
  jq: { debian: "jq", rhel: "jq", arch: "jq", alpine: "jq" },
  htop: { debian: "htop", rhel: "htop", arch: "htop", alpine: "htop" },
  tree: { debian: "tree", rhel: "tree", arch: "tree", alpine: "tree" },
  locate: { debian: "mlocate", rhel: "mlocate", arch: "mlocate", alpine: "mlocate" },
  certbot: { debian: "certbot", rhel: "certbot", arch: "certbot", alpine: "certbot" },
  nc: { debian: "netcat-openbsd", rhel: "nmap-ncat", arch: "gnu-netcat", alpine: "netcat-openbsd" },
};

/**
 * Get the package name for a command on the detected platform.
 */
export function getPackageForCommand(command: string, platform: PlatformInfo): string | undefined {
  const mapping = COMMAND_TO_PACKAGE[command];
  if (!mapping) return command; // Default: package name = command name
  return mapping[platform.distroFamily] ?? command;
}

/**
 * Format platform info for display.
 */
export function formatPlatform(info: PlatformInfo): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m" };
  const wslLabel = info.isWSL ? ` ${c.yellow}(WSL)${c.reset}` : "";
  return [
    `${c.bold}Platform:${c.reset}`,
    `  OS:        ${info.distro}${wslLabel}`,
    `  Kernel:    ${info.kernel}`,
    `  Arch:      ${info.arch}`,
    `  Shell:     ${info.shell}`,
    `  Packages:  ${info.packageManager}`,
    `  Init:      ${info.initSystem}`,
  ].join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function commandExists(cmd: string): boolean {
  return tryExec(`command -v ${cmd}`) !== null;
}

function extractField(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}="?([^"\\n]*)"?`, "m"));
  return match?.[1] ?? null;
}
