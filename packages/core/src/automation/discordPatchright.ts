/**
 * Discord Developer Portal automation via patchright.
 *
 * Runs on Windows Node via cmd.exe (patchright can't launch visible
 * Windows browsers from WSL due to pipe FD limitation).
 *
 * Scripts are written to C:\temp and executed via Windows Node.
 * Browser uses persistent profile at C:\temp\notoken-browser-profile
 * to preserve Discord login sessions across runs.
 *
 * User handles: captcha, MFA (password). Script waits patiently.
 * Token captured via Windows clipboard (Get-Clipboard).
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

function tryExec(cmd: string, timeout = 15_000): string {
  try {
    return execSync(cmd, { timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    return e.stdout?.trim?.() ?? "";
  }
}

const isNativeWin = process.platform === "win32";
const tempDir = isNativeWin ? "C:\\temp" : "/mnt/c/temp";
const tempDirPosix = isNativeWin ? "/c/temp" : "/mnt/c/temp";
const cmdPrefix = isNativeWin ? `cmd.exe /c "cd ${tempDir} &&` : `/mnt/c/Windows/System32/cmd.exe /c "cd ${tempDir} &&`;

function winExec(script: string, timeout = 300_000): string {
  // Write script to temp dir, run via Node
  const scriptPath = isNativeWin ? `${tempDir}\\notoken-discord-script.js` : `${tempDir}/notoken-discord-script.js`;
  try { execSync(`mkdir ${isNativeWin ? tempDir : "-p " + tempDir}`, { stdio: "pipe" }); } catch {}
  writeFileSync(scriptPath, script);
  return tryExec(`${cmdPrefix} node notoken-discord-script.js"`, timeout);
}

/**
 * Ensure patchright is installed on Windows.
 */
export function ensurePatchright(): boolean {
  try { execSync(`mkdir ${isNativeWin ? tempDir : "-p " + tempDir}`, { stdio: "pipe" }); } catch {}
  const check = tryExec(`${cmdPrefix} node -e \\"require('patchright');\\"" 2>&1`);
  if (check.includes("Cannot find")) {
    console.log(`  ${c.dim}Installing patchright...${c.reset}`);
    tryExec(`${cmdPrefix} npm install patchright" 2>&1`, 60_000);
    return true;
  }
  return true;
}

/** Detect which browser channel is available */
function detectBrowserChannel(): string {
  if (isNativeWin) {
    if (existsSync("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe") ||
        existsSync("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe")) return "msedge";
    if (existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") ||
        existsSync("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe")) return "chrome";
  } else {
    // WSL — check Windows browsers via /mnt/c
    if (existsSync("/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ||
        existsSync("/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe")) return "msedge";
    if (existsSync("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe")) return "chrome";
  }
  return "chromium"; // fallback to bundled
}

/**
 * Create a Discord bot application, get token, enable intents.
 * Returns { token, appId, success }.
 */
export async function createDiscordBot(appName = "NoToken-Bot"): Promise<{ token: string; appId: string; success: boolean }> {
  ensurePatchright();

  const uniqueName = `${appName}-${Date.now().toString().slice(-4)}`;
  const browserChannel = detectBrowserChannel();
  console.log(`\n${c.bold}${c.cyan}── Creating Discord Bot: ${uniqueName} ──${c.reset}`);
  console.log(`${c.dim}  Browser: ${browserChannel}${c.reset}\n`);

  const script = `
const { chromium } = require('patchright');
const fs = require('fs');
const APP_NAME = '${uniqueName}';
const USER_DATA_DIR = 'C:\\\\temp\\\\notoken-browser-profile';

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, channel: '${browserChannel}',
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  // Navigate
  await page.goto('https://discord.com/developers/applications', { timeout: 60000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);

  // Login handling
  if (await page.locator('button:has-text("Log In")').first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.locator('button:has-text("Log In")').first().click();
    await page.waitForTimeout(2000);
  }
  if (page.url().includes('/login') || await page.locator('input[name="password"]').isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('LOGIN_REQUIRED');
    await page.waitForURL('**/developers/applications**', { timeout: 600000 });
    await page.waitForTimeout(3000);
  }
  console.log('LOGGED_IN');

  // Dismiss survey
  await page.locator('button[aria-label="Dismiss"]').click({ timeout: 1000 }).catch(() => {});

  // Create app
  await page.waitForSelector('button:has-text("New Application")', { timeout: 10000 });
  await page.click('button:has-text("New Application")');
  await page.waitForSelector('input#appname', { timeout: 5000 });
  await page.locator('input#appname').click();
  await page.locator('input#appname').fill(APP_NAME);
  await page.locator('div[class*="checkboxIndicator"]').first().click();
  await page.waitForTimeout(300);
  await page.locator('button[class*="primary"]:has-text("Create")').first().click();
  console.log('CREATE_CLICKED');

  // Wait for captcha/redirect
  await page.waitForURL(/applications\\/\\d+/, { timeout: 300000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  const appId = (page.url().match(/applications\\/(\\d+)/) || [])[1] || '';
  console.log('APP_CREATED:' + appId);

  // Bot tab
  await page.locator('a:has-text("Bot")').first().click();
  await page.waitForSelector('button:has-text("Reset Token")', { timeout: 10000 });

  // Reset Token
  await page.click('button:has-text("Reset Token")');
  await page.waitForTimeout(1500);
  await page.click('button:has-text("Yes, do it!")', { timeout: 5000 }).catch(() => {});
  console.log('TOKEN_RESET');

  // Wait for MFA/token — poll
  let token = '';
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000);
    token = await page.evaluate(() => {
      for (const inp of document.querySelectorAll('input')) {
        const val = inp.getAttribute('value') || inp.value;
        if (val && val.includes('.') && val.length > 50 && val !== '0') return val;
      }
      return '';
    }).catch(() => '');
    if (token) break;

    // Try Copy + clipboard
    if (i % 3 === 2) {
      await page.locator('div[class*="copyButton"] button').first().click({ timeout: 500 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    if (i % 10 === 0 && i > 0) console.log('POLLING:' + (i * 2) + 's');
  }

  // If no token from DOM, try clipboard
  if (!token) {
    console.log('TRYING_CLIPBOARD');
  }

  // Enable intents
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  await page.locator('text=Privileged Gateway Intents').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(1000);
  const switches = await page.locator('label[data-react-aria-pressable="true"] input[role="switch"]').all();
  let toggled = 0;
  for (const sw of switches) {
    if (!await sw.isChecked().catch(() => true)) {
      await sw.locator('..').locator('..').first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      toggled++;
    }
  }
  await page.click('button:has-text("Save Changes")', { timeout: 3000 }).catch(() => {});
  console.log('INTENTS_ENABLED:' + toggled);

  // Save result
  const result = { token, appId, success: !!token };
  fs.writeFileSync('C:\\\\temp\\\\discord-bot-result.json', JSON.stringify(result));
  if (token) console.log('TOKEN:' + token);
  console.log('DONE');
  await ctx.close();
})().catch(e => console.error('FATAL:' + e.message));
`;

  const output = winExec(script, 600_000);

  // Parse output
  const lines = output.split("\n");
  let appId = "";
  let token = "";

  for (const line of lines) {
    if (line.startsWith("APP_CREATED:")) appId = line.replace("APP_CREATED:", "");
    if (line.startsWith("TOKEN:")) token = line.replace("TOKEN:", "");
    if (line === "LOGIN_REQUIRED") console.log(`  ${c.yellow}Log in to Discord in the browser window...${c.reset}`);
    if (line === "LOGGED_IN") console.log(`  ${c.green}✓${c.reset} Logged in`);
    if (line === "CREATE_CLICKED") console.log(`  ${c.dim}Creating app — solve captcha if shown...${c.reset}`);
    if (line.startsWith("APP_CREATED")) console.log(`  ${c.green}✓${c.reset} App created: ${appId}`);
    if (line === "TOKEN_RESET") console.log(`  ${c.dim}Token reset — complete MFA if shown...${c.reset}`);
    if (line.startsWith("POLLING")) console.log(`  ${c.dim}Waiting for token... ${line.replace("POLLING:", "")}${c.reset}`);
    if (line.startsWith("INTENTS_ENABLED")) console.log(`  ${c.green}✓${c.reset} Intents enabled: ${line.replace("INTENTS_ENABLED:", "")}`);
    if (line === "TRYING_CLIPBOARD") console.log(`  ${c.dim}Checking clipboard...${c.reset}`);
  }

  // If token not from DOM, try clipboard
  if (!token) {
    const psCmd = isNativeWin
      ? 'powershell -Command "Get-Clipboard" 2>/dev/null'
      : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Get-Clipboard" 2>/dev/null';
    token = tryExec(psCmd);
    if (token && token.includes(".") && token.length > 50) {
      console.log(`  ${c.green}✓${c.reset} Token captured from clipboard`);
    } else {
      token = "";
    }
  }

  // Also try saved result
  if (!token) {
    try {
      const saved = JSON.parse(readFileSync(`${tempDirPosix}/discord-bot-result.json`, "utf-8"));
      if (saved.token) token = saved.token;
      if (saved.appId && !appId) appId = saved.appId;
    } catch {}
  }

  if (token) {
    console.log(`  ${c.green}✓${c.reset} Token: ${token.substring(0, 25)}...`);
  } else {
    console.log(`  ${c.red}✗${c.reset} Could not capture token`);
  }

  return { token, appId, success: !!token };
}

/**
 * Authorize (invite) a Discord bot to a server.
 * Opens invite page, selects server, clicks authorize, waits for captcha.
 */
export async function authorizeDiscordBot(appId: string): Promise<boolean> {
  ensurePatchright();
  const browserChannel = detectBrowserChannel();
  console.log(`\n  ${c.dim}Opening invite page...${c.reset}`);

  const script = `
const { chromium } = require('patchright');
(async () => {
  const ctx = await chromium.launchPersistentContext('C:\\\\temp\\\\notoken-browser-profile', {
    headless: false, channel: '${browserChannel}',
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  await page.goto('https://discord.com/oauth2/authorize?client_id=${appId}&permissions=68608&scope=bot', { timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(5000);

  // Select server
  await page.locator('[role="combobox"]').click({ timeout: 5000 });
  await page.waitForTimeout(2000);
  const opt = page.locator('[role="option"]').first();
  const name = await opt.textContent().catch(() => '');
  console.log('SERVER:' + name);
  await opt.click();
  await page.waitForTimeout(1000);

  // Continue
  await page.click('button:has-text("Continue")', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Authorize
  await page.click('button:has-text("Authorize")', { timeout: 5000 }).catch(() => {});
  console.log('AUTHORIZE_CLICKED');

  // Wait for captcha resolution — poll for redirect
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2000);
    if (page.url().includes('authorized')) { console.log('AUTHORIZED'); break; }
    if (i % 15 === 0 && i > 0) console.log('WAITING_CAPTCHA:' + (i * 2) + 's');
  }

  await ctx.close();
})().catch(e => console.error('FATAL:' + e.message));
`;

  const output = winExec(script, 300_000);

  for (const line of output.split("\n")) {
    if (line.startsWith("SERVER:")) console.log(`  ${c.green}✓${c.reset} Server: ${line.replace("SERVER:", "")}`);
    if (line === "AUTHORIZE_CLICKED") console.log(`  ${c.dim}Authorize clicked — solve captcha if shown...${c.reset}`);
    if (line.startsWith("WAITING_CAPTCHA")) console.log(`  ${c.dim}Waiting... ${line.replace("WAITING_CAPTCHA:", "")}${c.reset}`);
    if (line === "AUTHORIZED") console.log(`  ${c.green}✓${c.reset} Bot authorized!`);
  }

  return output.includes("AUTHORIZED");
}

/**
 * Enable all Privileged Gateway Intents on the Discord Developer Portal.
 */
export async function enableDiscordIntents(appId: string): Promise<boolean> {
  ensurePatchright();
  const browserChannel = detectBrowserChannel();
  console.log(`  ${c.dim}Enabling intents on Developer Portal...${c.reset}`);

  const script = `
const { chromium } = require('patchright');
(async () => {
  const ctx = await chromium.launchPersistentContext('C:\\\\temp\\\\notoken-browser-profile', {
    headless: false, channel: '${browserChannel}',
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  await page.goto('https://discord.com/developers/applications/${appId}/bot', { timeout: 60000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(5000);

  // Login if needed
  if (await page.locator('button:has-text("Log In")').first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.locator('button:has-text("Log In")').first().click();
    console.log('LOGIN_REQUIRED');
    await page.waitForURL('**/${appId}/bot**', { timeout: 600000 });
    await page.waitForTimeout(3000);
  }

  // Scroll to intents
  await page.locator('text=Privileged Gateway Intents').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(2000);

  // Enable unchecked switches
  const switches = await page.locator('label[data-react-aria-pressable="true"] input[role="switch"]').all();
  let toggled = 0;
  for (const sw of switches) {
    if (!await sw.isChecked().catch(() => true)) {
      await sw.locator('..').locator('..').first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      toggled++;
    }
  }

  await page.click('button:has-text("Save Changes")', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('ENABLED:' + toggled);
  await ctx.close();
})().catch(e => console.error('FATAL:' + e.message));
`;

  const output = winExec(script, 120_000);
  const enabled = output.includes("ENABLED:");
  const count = output.match(/ENABLED:(\d+)/)?.[1] ?? "0";
  if (enabled) console.log(`  ${c.green}✓${c.reset} Enabled ${count} intent(s)`);
  return enabled;
}
