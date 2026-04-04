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

  // Intercept API responses to capture token from network
  let tokenFromApi = '';
  page.on('response', async (resp) => {
    try {
      if (resp.url().includes('/bot/reset') || resp.url().includes('/bot/token') || resp.url().includes('/applications/')) {
        const body = await resp.text().catch(() => '');
        const match = body.match(/"token"\\s*:\\s*"([^"]+)"/);
        if (match && match[1].includes('.') && match[1].length > 50) {
          tokenFromApi = match[1];
          fs.writeFileSync('C:\\\\temp\\\\discord-token-api.txt', tokenFromApi);
          console.log('TOKEN_FROM_API');
        }
      }
    } catch {}
  });

  // Reset Token
  await page.click('button:has-text("Reset Token")');
  await page.waitForTimeout(1500);
  await page.click('button:has-text("Yes, do it!")', { timeout: 5000 }).catch(() => {});
  console.log('TOKEN_RESET');

  // Wait for MFA/token — poll API intercept, DOM, clipboard
  let token = '';
  const log = [];
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000);

    // Check API intercept first (most reliable)
    if (tokenFromApi) { token = tokenFromApi; log.push('SOURCE:api'); break; }

    // Check all page content for token pattern
    token = await page.evaluate(() => {
      const found = [];
      // Walk entire DOM text
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent || '';
        if (text.includes('.') && text.length > 50 && text.length < 200 && !text.includes(' ') && !text.includes('\\n')) {
          found.push(text.trim());
        }
      }
      // Check input values
      for (const inp of document.querySelectorAll('input')) {
        const val = inp.value || inp.getAttribute('value') || '';
        if (val.includes('.') && val.length > 50 && val.length < 200 && !val.includes(' ')) {
          found.push(val.trim());
        }
      }
      return found[0] || '';
    }).catch(() => '');
    if (token) { log.push('SOURCE:dom'); break; }

    // Click Copy and check clipboard
    if (i % 2 === 1) {
      await page.locator('button:has-text("Copy")').first().click({ timeout: 500 }).catch(() => {});
      await page.locator('[class*="copy"] button, [class*="Copy"] button, button[class*="copy"]').first().click({ timeout: 500 }).catch(() => {});
      await page.waitForTimeout(500);
      try {
        const { execSync: es } = require('child_process');
        const clip = es('powershell -Command "Get-Clipboard"', { encoding: 'utf-8', timeout: 3000 }).trim();
        if (clip && clip.includes('.') && clip.length > 50 && clip.length < 200 && !clip.includes(' ')) {
          token = clip;
          log.push('SOURCE:clipboard');
          break;
        }
      } catch {}
    }
    if (i % 5 === 0) log.push('POLL:' + (i * 2) + 's');
  }

  // Write debug log
  fs.writeFileSync('C:\\\\temp\\\\discord-debug.log', log.join('\\n') + '\\nTOKEN_LEN:' + token.length + '\\nAPI_LEN:' + tokenFromApi.length);

  if (!token && tokenFromApi) token = tokenFromApi;
  if (!token) {
    console.log('TOKEN_NOT_FOUND');
  }

  // Enable privileged intents (but NOT Code Grant which is switch index 1)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  await page.locator('text=Privileged Gateway Intents').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(1000);
  const allSwitches = await page.locator('input[role="switch"]').all();
  let toggled = 0;
  // Skip switches 0 (Public Bot) and 1 (Code Grant) — only toggle intent switches (index 2+)
  for (let idx = 2; idx < allSwitches.length; idx++) {
    const sw = allSwitches[idx];
    if (!await sw.isChecked().catch(() => true)) {
      await sw.locator('..').locator('..').first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      toggled++;
    }
  }
  await page.click('button:has-text("Save Changes")', { timeout: 3000 }).catch(() => {});
  console.log('INTENTS_ENABLED:' + toggled);

  // Ensure Code Grant is OFF (switch index 1)
  if (allSwitches.length >= 2) {
    const codeGrantOn = await allSwitches[1].isChecked().catch(() => false);
    if (codeGrantOn) {
      await allSwitches[1].locator('..').click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      await page.click('button:has-text("Save Changes")', { timeout: 3000 }).catch(() => {});
      console.log('CODE_GRANT_DISABLED');
    }
  }

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
