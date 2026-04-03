/**
 * Stability Matrix UI Automation via PowerShell.
 *
 * Uses Windows UIAutomation COM API through PowerShell to:
 *   - Launch SM and wait for window
 *   - Click "Add Package" button
 *   - Select the right package (Forge, ComfyUI, etc.)
 *   - Click Install and monitor progress
 *   - Click Launch when done
 *   - Configure settings
 *
 * All automation runs on Windows side via PowerShell.
 * From WSL, commands are sent through /mnt/c/.../powershell.exe
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { findStabilityMatrix, type SMLocation } from "../utils/stabilityMatrixManager.js";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const PS_WIN = "powershell.exe";

function tryExec(cmd: string, timeout = 10000): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout }).trim() || null;
  } catch { return null; }
}

function isWSL(): boolean {
  try {
    return !!execSync("grep -qi microsoft /proc/version && echo wsl", {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000,
    }).trim();
  } catch { return false; }
}

function ps(script: string, timeout = 30000): string | null {
  const psExe = isWSL() ? PS : PS_WIN;
  // Escape for bash → powershell
  const escaped = script.replace(/'/g, "''");
  try {
    return execSync(`${psExe} -NoProfile -Command "${escaped}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    }).trim() || null;
  } catch { return null; }
}

function psRun(script: string, timeout = 30000): void {
  const psExe = isWSL() ? PS : PS_WIN;
  execSync(`${psExe} -NoProfile -Command "${script.replace(/'/g, "''")}"`, {
    stdio: "inherit",
    timeout,
  });
}

// ─── Window Management ─────────────────────────────────────────────────────

export function isSMRunning(): boolean {
  return !!ps("Get-Process StabilityMatrix -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id");
}

export function launchSM(sm: SMLocation): boolean {
  if (isSMRunning()) {
    console.log(`${c.dim}  SM already running${c.reset}`);
    return true;
  }

  const smExe = sm.platform === "wsl"
    ? tryExec(`wslpath -w "${sm.path}/StabilityMatrix.exe"`)
    : `${sm.path}\\StabilityMatrix.exe`;

  if (!smExe) return false;

  console.log(`${c.dim}  Launching Stability Matrix...${c.reset}`);
  ps(`Start-Process '${smExe}'`);

  // Wait for window
  for (let i = 0; i < 20; i++) {
    if (isSMRunning()) return true;
    tryExec("sleep 1");
  }
  return isSMRunning();
}

export function focusSMWindow(): boolean {
  return !!ps(`
    Add-Type -AssemblyName UIAutomationClient
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Stability Matrix')
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($win) {
      $pattern = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
      $pattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
      Write-Output 'focused'
    }
  `);
}

// ─── UI Automation Helpers ─────────────────────────────────────────────────

/**
 * Find a UI element by name/automationId and click it.
 */
export function clickButton(name: string, timeout = 10000): boolean {
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement

# Find SM window
$smCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, 'Stability Matrix')
$smWin = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $smCond)

if (-not $smWin) {
  # Try partial match
  $procs = Get-Process StabilityMatrix -ErrorAction SilentlyContinue
  if ($procs) {
    $smCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procs[0].Id)
    $smWin = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $smCond)
  }
}

if (-not $smWin) { Write-Output 'WINDOW_NOT_FOUND'; exit 1 }

# Find button by name
$btnCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, '${name}')
$btn = $smWin.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)

if (-not $btn) {
  # Try AutomationId
  $btnCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '${name}')
  $btn = $smWin.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
}

if (-not $btn) { Write-Output 'BUTTON_NOT_FOUND'; exit 1 }

# Click it
$invokePattern = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invokePattern.Invoke()
Write-Output 'CLICKED'
`;
  const result = ps(script, timeout);
  return result === "CLICKED";
}

/**
 * Find a UI element by partial text match and click it.
 */
export function clickByText(text: string): boolean {
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$procs = Get-Process StabilityMatrix -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output 'NOT_RUNNING'; exit 1 }

$smCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procs[0].Id)
$smWin = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $smCond)
if (-not $smWin) { Write-Output 'WINDOW_NOT_FOUND'; exit 1 }

# Search all descendants for text match
$all = $smWin.FindAll([System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition)

foreach ($el in $all) {
  $elName = $el.Current.Name
  if ($elName -like '*${text}*') {
    try {
      $invokePattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $invokePattern.Invoke()
      Write-Output "CLICKED: $elName"
      exit 0
    } catch {
      # Try SelectionItemPattern for list items
      try {
        $selectPattern = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $selectPattern.Select()
        Write-Output "SELECTED: $elName"
        exit 0
      } catch {}
    }
  }
}
Write-Output 'TEXT_NOT_FOUND'
`;
  const result = ps(script, 15000);
  return !!result && (result.startsWith("CLICKED") || result.startsWith("SELECTED"));
}

/**
 * List all clickable elements in SM window (for debugging).
 */
export function listUIElements(): string[] {
  const script = `
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$procs = Get-Process StabilityMatrix -ErrorAction SilentlyContinue
if (-not $procs) { exit 1 }

$smCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procs[0].Id)
$smWin = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $smCond)
if (-not $smWin) { exit 1 }

$all = $smWin.FindAll([System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition)

foreach ($el in $all) {
  $name = $el.Current.Name
  $type = $el.Current.ControlType.ProgrammaticName
  $id = $el.Current.AutomationId
  if ($name -or $id) {
    Write-Output "$type | $name | $id"
  }
}
`;
  const result = ps(script, 20000);
  return result ? result.split("\n").filter(l => l.trim()) : [];
}

// ─── High-Level Actions ────────────────────────────────────────────────────

/**
 * Full automated install flow:
 *   1. Launch SM
 *   2. Click "Add Package"
 *   3. Select package (Forge, ComfyUI, etc.)
 *   4. Click Install
 *   5. Wait for completion
 *   6. Click Launch
 */
export async function automateInstallPackage(
  packageName: string = "Stable Diffusion WebUI Forge"
): Promise<{ success: boolean; message: string }> {
  const sm = findStabilityMatrix();
  if (!sm) return { success: false, message: "Stability Matrix not found" };

  console.log(`${c.cyan}Step 1/${c.reset} Launching Stability Matrix...`);
  if (!launchSM(sm)) {
    return { success: false, message: "Could not launch Stability Matrix" };
  }

  // Wait for UI to be ready
  await sleep(3000);

  console.log(`${c.cyan}Step 2/${c.reset} Looking for Add Package button...`);
  // SM uses Avalonia UI — try common button names
  let clicked = clickButton("Add Package") || clickButton("AddPackageButton") || clickByText("Add");

  if (!clicked) {
    // List elements to help debug
    console.log(`${c.dim}  Could not find Add Package button. Available elements:${c.reset}`);
    const elements = listUIElements();
    const relevant = elements.filter(e =>
      e.toLowerCase().includes("add") || e.toLowerCase().includes("install") ||
      e.toLowerCase().includes("package") || e.toLowerCase().includes("button")
    ).slice(0, 10);
    for (const el of relevant) {
      console.log(`${c.dim}    ${el}${c.reset}`);
    }
    return { success: false, message: "Could not find Add Package button — SM UI may have changed" };
  }

  await sleep(2000);

  console.log(`${c.cyan}Step 3/${c.reset} Selecting ${packageName}...`);
  clicked = clickByText(packageName);
  if (!clicked) {
    console.log(`${c.yellow}⚠${c.reset} Could not find "${packageName}" in package list`);
    return { success: false, message: `Package "${packageName}" not found in SM` };
  }

  await sleep(1000);

  console.log(`${c.cyan}Step 4/${c.reset} Clicking Install...`);
  clicked = clickButton("Install") || clickByText("Install");
  if (!clicked) {
    return { success: false, message: "Could not find Install button" };
  }

  console.log(`${c.cyan}Step 5/${c.reset} Installation started — monitoring progress...`);
  console.log(`${c.dim}  SM is downloading Python, models, and all dependencies.${c.reset}`);
  console.log(`${c.dim}  This may take 10-30 minutes.${c.reset}`);

  // Monitor by checking if the install is still running
  // SM shows a progress bar — we can check if the Launch button appears
  for (let i = 0; i < 120; i++) { // Up to 60 minutes
    await sleep(30000);
    const elapsed = (i + 1) * 30;
    console.log(`${c.dim}  ${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed...${c.reset}`);

    // Check if Launch button appeared (install done)
    if (clickButton("Launch") || clickByText("Launch")) {
      console.log(`${c.green}✓${c.reset} Installation complete — package launched!`);
      return { success: true, message: `${c.green}✓${c.reset} ${packageName} installed and launched via Stability Matrix` };
    }
  }

  return { success: false, message: "Installation timed out after 60 minutes" };
}

/**
 * Launch the active package.
 */
export async function automateLaunch(): Promise<{ success: boolean; message: string }> {
  const sm = findStabilityMatrix();
  if (!sm) return { success: false, message: "Stability Matrix not found" };

  if (!launchSM(sm)) {
    return { success: false, message: "Could not launch SM" };
  }

  await sleep(3000);

  console.log(`${c.dim}  Clicking Launch...${c.reset}`);
  const clicked = clickButton("Launch") || clickByText("Launch");
  if (!clicked) {
    return { success: false, message: "Could not find Launch button — package may not be installed" };
  }

  return { success: true, message: `${c.green}✓${c.reset} Package launching...` };
}

// ─── Status & Diagnostics ──────────────────────────────────────────────────

/**
 * Check SD API from the Windows side (bypasses WSL networking issues).
 */
export function checkAPIFromWindows(port = 7860): { running: boolean; statusCode: number; models?: string[] } {
  const result = ps(`
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:${port}/sdapi/v1/sd-models" -TimeoutSec 5
      Write-Output "OK:$($r.StatusCode):$($r.Content.Substring(0, [Math]::Min(500, $r.Content.Length)))"
    } catch {
      $code = 0
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      Write-Output "FAIL:$code:$($_.Exception.Message)"
    }
  `, 10000);

  if (!result) return { running: false, statusCode: 0 };

  const [status, code, body] = result.split(":", 3);
  if (status === "OK") {
    try {
      const models = JSON.parse(body).map((m: { model_name: string }) => m.model_name);
      return { running: true, statusCode: parseInt(code), models };
    } catch {
      return { running: true, statusCode: parseInt(code) };
    }
  }
  return { running: false, statusCode: parseInt(code) || 0 };
}

/**
 * Check what port SD is listening on from Windows.
 */
export function findSDPort(): number | null {
  const result = ps(`
    $ports = @(7860, 7861, 8188, 9090)
    foreach ($p in $ports) {
      $tcp = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue
      if ($tcp) { Write-Output $p; exit }
    }
    Write-Output "NONE"
  `, 10000);
  if (!result || result === "NONE") return null;
  return parseInt(result);
}

/**
 * Get Python process info from Windows.
 */
export function getPythonProcesses(): Array<{ pid: number; ram: number; path: string }> {
  const result = ps(`
    Get-Process python* -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Output "$($_.Id)|$($_.WorkingSet64)|$($_.Path)"
    }
  `, 10000);
  if (!result) return [];
  return result.split("\n").filter(l => l.includes("|")).map(line => {
    const [pid, ram, path] = line.split("|");
    return { pid: parseInt(pid), ram: parseInt(ram), path: path?.trim() ?? "" };
  });
}

/**
 * Full diagnostic — check everything and report.
 */
export async function diagnoseSD(): Promise<string> {
  const lines: string[] = [];
  lines.push(`${c.bold}${c.cyan}SD Diagnostic Report${c.reset}\n`);

  // 1. SM process
  const smRunning = isSMRunning();
  lines.push(`${smRunning ? c.green + "✓" : c.red + "✗"}${c.reset} Stability Matrix: ${smRunning ? "running" : "not running"}`);

  // 2. Python processes
  const pythons = getPythonProcesses();
  const sdPython = pythons.filter(p => p.path.includes("reforge") || p.path.includes("StabilityMatrix") || p.ram > 1_000_000_000);
  lines.push(`${sdPython.length > 0 ? c.green + "✓" : c.red + "✗"}${c.reset} Python processes: ${sdPython.length} SD-related`);
  for (const p of sdPython) {
    lines.push(`  ${c.dim}PID ${p.pid} — ${(p.ram / 1073741824).toFixed(1)}GB RAM — ${p.path}${c.reset}`);
  }

  // 3. Port
  const port = findSDPort();
  lines.push(`${port ? c.green + "✓" : c.yellow + "⚠"}${c.reset} Port: ${port ? `${port} listening` : "no SD port detected"}`);

  // 4. API
  if (port) {
    const api = checkAPIFromWindows(port);
    lines.push(`${api.running ? c.green + "✓" : c.yellow + "⚠"}${c.reset} API: ${api.running ? `responding (HTTP ${api.statusCode})` : `not ready (HTTP ${api.statusCode}) — still loading`}`);
    if (api.models) {
      lines.push(`  ${c.dim}Models: ${api.models.join(", ")}${c.reset}`);
    }
  } else {
    lines.push(`${c.red}✗${c.reset} API: no port listening — SD may have failed to start`);
  }

  // 5. WSL↔Windows connectivity
  if (port && isWSL()) {
    const winIP = tryExec("cat /etc/resolv.conf | grep nameserver | awk '{print $2}'");
    const wslReach = tryExec(`curl -sf --max-time 2 http://${winIP}:${port}/ 2>/dev/null`);
    const localReach = tryExec(`curl -sf --max-time 2 http://localhost:${port}/ 2>/dev/null`);
    lines.push(`${localReach ? c.green + "✓" : c.yellow + "⚠"}${c.reset} WSL localhost:${port}: ${localReach ? "reachable" : "not reachable"}`);
    lines.push(`${wslReach ? c.green + "✓" : c.yellow + "⚠"}${c.reset} WSL→Windows (${winIP}:${port}): ${wslReach ? "reachable" : "not reachable — need --listen flag"}`);
  }

  // 6. SM settings check
  const sm = findStabilityMatrix();
  if (sm) {
    const { getActivePackage: getActive } = await import("../utils/stabilityMatrixManager.js");
    const active = getActive(sm);
    if (active) {
      const hasApi = active.LaunchArgs.some(a => a.Name === "--api" && a.OptionValue === true);
      const hasListen = active.LaunchArgs.some(a => a.Name === "--listen" && a.OptionValue === true);
      lines.push(`${hasApi ? c.green + "✓" : c.red + "✗"}${c.reset} --api flag: ${hasApi ? "enabled" : "DISABLED — enable with: notoken sd config --api"}`);
      lines.push(`${hasListen ? c.green + "✓" : c.yellow + "⚠"}${c.reset} --listen flag: ${hasListen ? "enabled" : "disabled — needed for WSL access"}`);
    }
  }

  return lines.join("\n");
}

/**
 * Stop SD — kill Python processes running the package.
 */
export function stopSD(): string {
  ps(`
    Get-Process python* -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -like '*reforge*' -or $_.Path -like '*StabilityMatrix*'
    } | Stop-Process -Force
  `, 10000);
  return `${c.green}✓${c.reset} SD processes stopped`;
}

/**
 * Restart SD — stop then launch.
 */
export async function restartSD(): Promise<string> {
  stopSD();
  await sleep(2000);

  const sm = findStabilityMatrix();
  if (!sm) return `${c.red}✗${c.reset} SM not found`;

  if (!isSMRunning()) launchSM(sm);
  await sleep(3000);

  clickButton("LaunchButton");
  return `${c.green}✓${c.reset} SD restarting — check status in a minute`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
