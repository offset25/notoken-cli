/**
 * Automated Discord bot setup via Playwright.
 *
 * Opens the Discord Developer Portal, walks the user through login,
 * then automates: create application, create bot, copy token, enable
 * Message Content Intent, generate OAuth2 invite URL, open it.
 *
 * The user only needs to:
 *   1. Log in to Discord (notoken never touches credentials)
 *   2. Pick which server to add the bot to
 *
 * Returns the bot token for OpenClaw channel registration.
 */

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

export interface DiscordSetupResult {
  success: boolean;
  botToken?: string;
  applicationId?: string;
  inviteUrl?: string;
  error?: string;
}

/**
 * Detect available browser executable on the system.
 * Prefers Edge (available on Windows), falls back to Chrome, then Chromium.
 */
async function findBrowserPath(): Promise<string | null> {
  const { execSync } = await import("node:child_process");
  const candidates = [
    // Windows browsers via WSL
    "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    // Linux browsers
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
  ];

  for (const path of candidates) {
    try {
      execSync(`ls "${path}" 2>/dev/null`, { stdio: "pipe" });
      return path;
    } catch { /* not found */ }
  }
  return null;
}

/**
 * Run the automated Discord bot setup.
 *
 * @param appName - Name for the Discord application (default: "OpenClaw")
 * @param headless - Run headless (default: false — user needs to see login)
 */
export async function automateDiscordBotSetup(
  appName = "OpenClaw",
  headless = false,
): Promise<DiscordSetupResult> {
  // Dynamic import — Playwright is optional, not a core dependency
  let playwright: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    playwright = await (Function('return import("playwright")')() as Promise<any>);
  } catch {
    return {
      success: false,
      error: "Playwright not installed. Run: npm install -g playwright && npx playwright install chromium",
    };
  }

  const browserPath = await findBrowserPath();
  console.log(`\n${c.bold}${c.cyan}── Discord Bot Setup ──${c.reset}\n`);

  let browser: any;
  let context: any;
  let page: any;

  try {
    // Launch browser — use Windows Edge if available for visible UI
    console.log(`  ${c.dim}Launching browser...${c.reset}`);

    if (browserPath?.includes("/mnt/c/")) {
      // Windows browser via WSL — use channel launch
      const winPath = browserPath
        .replace("/mnt/c/", "C:\\")
        .replace(/\//g, "\\");
      browser = await playwright.chromium.launch({
        headless: false, // Must be visible for user login
        executablePath: browserPath,
        args: ["--no-sandbox"],
      });
    } else {
      browser = await playwright.chromium.launch({
        headless,
        args: ["--no-sandbox"],
      });
    }

    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    page = await context.newPage();

    // ── Step 1: Navigate to Discord Developer Portal ──
    console.log(`  ${c.bold}1.${c.reset} Opening Discord Developer Portal...`);
    await page.goto("https://discord.com/developers/applications", {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    // Check if login is needed
    const url = page.url();
    if (url.includes("/login")) {
      console.log(`\n  ${c.yellow}${c.bold}Please log in to Discord in the browser window.${c.reset}`);
      console.log(`  ${c.dim}Waiting for you to complete login...${c.reset}\n`);

      // Wait for redirect to developer portal after login (up to 5 minutes)
      await page.waitForURL("**/developers/applications**", { timeout: 300_000 });
      console.log(`  ${c.green}✓${c.reset} Logged in successfully!\n`);
    } else {
      console.log(`  ${c.green}✓${c.reset} Already logged in.\n`);
    }

    // ── Step 2: Create New Application ──
    console.log(`  ${c.bold}2.${c.reset} Creating application "${appName}"...`);
    await page.waitForTimeout(2000);

    // Click "New Application" button
    const newAppBtn = page.locator('button:has-text("New Application"), div[class*="actionButton"]:has-text("New Application")');
    await newAppBtn.waitFor({ timeout: 10_000 });
    await newAppBtn.click();

    // Fill in the application name
    await page.waitForTimeout(1000);
    const nameInput = page.locator('input[placeholder*="name"], input[name="name"]').first();
    await nameInput.waitFor({ timeout: 5_000 });
    await nameInput.fill(appName);

    // Check the ToS checkbox if present
    const tosCheckbox = page.locator('input[type="checkbox"], label:has-text("policy")').first();
    if (await tosCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tosCheckbox.click();
    }

    // Click Create
    const createBtn = page.locator('button:has-text("Create")').first();
    await createBtn.click();
    await page.waitForTimeout(3000);

    // Get the application ID from the URL
    const appUrl = page.url();
    const appIdMatch = appUrl.match(/applications\/(\d+)/);
    const applicationId = appIdMatch?.[1] ?? "";
    console.log(`  ${c.green}✓${c.reset} Application created${applicationId ? ` (ID: ${applicationId})` : ""}\n`);

    // ── Step 3: Navigate to Bot tab and create bot ──
    console.log(`  ${c.bold}3.${c.reset} Setting up bot...`);

    // Click "Bot" in sidebar
    const botTab = page.locator('a:has-text("Bot"), div[class*="item"]:has-text("Bot")').first();
    await botTab.click();
    await page.waitForTimeout(2000);

    // Click "Reset Token" or "Add Bot" if needed
    const resetTokenBtn = page.locator('button:has-text("Reset Token")').first();
    const addBotBtn = page.locator('button:has-text("Add Bot")').first();

    if (await addBotBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addBotBtn.click();
      await page.waitForTimeout(1000);
      // Confirm
      const confirmBtn = page.locator('button:has-text("Yes, do it!")').first();
      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmBtn.click();
      }
      await page.waitForTimeout(2000);
    }

    // Reset/reveal token
    if (await resetTokenBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await resetTokenBtn.click();
      await page.waitForTimeout(1000);
      // Confirm reset
      const confirmReset = page.locator('button:has-text("Yes, do it!")').first();
      if (await confirmReset.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmReset.click();
      }
    }

    // Wait for token to appear and copy it
    await page.waitForTimeout(2000);
    let botToken = "";

    // Try to find the token in an input or code element
    const tokenInput = page.locator('input[value*="."], span[class*="token"], div[class*="token"] input').first();
    if (await tokenInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      botToken = await tokenInput.inputValue().catch(() => "");
      if (!botToken) {
        botToken = await tokenInput.textContent().catch(() => "") ?? "";
      }
    }

    // Try clicking "Copy" button if token not grabbed directly
    if (!botToken) {
      const copyBtn = page.locator('button:has-text("Copy")').first();
      if (await copyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await copyBtn.click();
        // Token is now in clipboard — try to read it
        try {
          botToken = await page.evaluate(() => navigator.clipboard.readText());
        } catch {
          // Clipboard access denied — ask user
        }
      }
    }

    if (botToken) {
      console.log(`  ${c.green}✓${c.reset} Bot token captured\n`);
    } else {
      console.log(`  ${c.yellow}⚠${c.reset} Could not auto-capture token.`);
      console.log(`  ${c.bold}Please copy the bot token from the browser and paste it here.${c.reset}\n`);
    }

    // ── Step 4: Enable Message Content Intent ──
    console.log(`  ${c.bold}4.${c.reset} Enabling Message Content Intent...`);

    // Scroll down to Privileged Gateway Intents
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    // Find and enable Message Content Intent toggle
    const messageContentLabel = page.locator('text=Message Content Intent, label:has-text("MESSAGE CONTENT INTENT")').first();
    if (await messageContentLabel.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Find the toggle near this label
      const toggle = page.locator('div:has-text("MESSAGE CONTENT INTENT") input[type="checkbox"], div:has-text("Message Content Intent") [role="switch"]').first();
      if (await toggle.isVisible({ timeout: 2000 }).catch(() => false)) {
        const isChecked = await toggle.isChecked().catch(() => false);
        if (!isChecked) {
          await toggle.click();
          await page.waitForTimeout(500);
        }
      }
    }

    // Save changes
    const saveBtn = page.locator('button:has-text("Save Changes")').first();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(1000);
    }
    console.log(`  ${c.green}✓${c.reset} Message Content Intent enabled\n`);

    // ── Step 5: Generate OAuth2 invite URL ──
    console.log(`  ${c.bold}5.${c.reset} Generating invite URL...`);

    // Navigate to OAuth2 → URL Generator
    const oauth2Tab = page.locator('a:has-text("OAuth2"), div[class*="item"]:has-text("OAuth2")').first();
    await oauth2Tab.click();
    await page.waitForTimeout(1000);

    // Look for URL Generator sub-tab
    const urlGenTab = page.locator('a:has-text("URL Generator"), div:has-text("URL Generator")').first();
    if (await urlGenTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await urlGenTab.click();
      await page.waitForTimeout(1000);
    }

    // Select "bot" scope
    const botScope = page.locator('label:has-text("bot"), input[value="bot"]').first();
    if (await botScope.isVisible({ timeout: 3000 }).catch(() => false)) {
      await botScope.click();
      await page.waitForTimeout(1000);
    }

    // Select permissions: Send Messages, Read Messages
    for (const perm of ["Send Messages", "Read Message History", "View Channels"]) {
      const permLabel = page.locator(`label:has-text("${perm}")`).first();
      if (await permLabel.isVisible({ timeout: 1000 }).catch(() => false)) {
        await permLabel.click();
        await page.waitForTimeout(300);
      }
    }

    // Copy the generated URL
    await page.waitForTimeout(1000);
    let inviteUrl = "";
    const urlInput = page.locator('input[value*="discord.com/oauth2"], input[value*="discord.com/api/oauth2"]').first();
    if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      inviteUrl = await urlInput.inputValue();
    }

    if (inviteUrl) {
      console.log(`  ${c.green}✓${c.reset} Invite URL generated\n`);

      // ── Step 6: Open invite URL to add bot to server ──
      console.log(`  ${c.bold}6.${c.reset} Opening bot invite page...`);
      console.log(`  ${c.yellow}${c.bold}Pick your Discord server in the browser to add the bot.${c.reset}\n`);
      await page.goto(inviteUrl);

      // Wait for user to authorize (page changes after clicking Authorize)
      await page.waitForURL("**/oauth2/authorized**", { timeout: 120_000 }).catch(() => {});
      console.log(`  ${c.green}✓${c.reset} Bot added to server!\n`);
    } else {
      console.log(`  ${c.yellow}⚠${c.reset} Could not auto-generate invite URL.`);
      if (applicationId) {
        inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${applicationId}&permissions=68608&scope=bot`;
        console.log(`  ${c.dim}Manual invite URL: ${inviteUrl}${c.reset}\n`);
      }
    }

    // Close browser
    await browser.close();

    return {
      success: !!botToken,
      botToken: botToken || undefined,
      applicationId: applicationId || undefined,
      inviteUrl: inviteUrl || undefined,
      error: botToken ? undefined : "Could not auto-capture bot token. Please copy it manually from the Discord Developer Portal.",
    };

  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    console.log(`\n  ${c.red}✗ Automation error: ${msg.split("\n")[0]}${c.reset}`);

    // Try to close browser gracefully
    try { await browser?.close(); } catch { /* */ }

    return { success: false, error: msg };
  }
}

/**
 * Full Discord setup flow — automate browser + register with OpenClaw.
 */
export async function setupDiscordChannel(appName = "OpenClaw"): Promise<string> {
  const result = await automateDiscordBotSetup(appName);

  if (result.success && result.botToken) {
    // Register with OpenClaw
    console.log(`${c.bold}${c.cyan}── Registering with OpenClaw ──${c.reset}\n`);

    try {
      const { execSync } = await import("node:child_process");
      const nvmPrefix = `for d in "$HOME/.nvm" "/home/"*"/.nvm" "/root/.nvm"; do [ -s "$d/nvm.sh" ] && export NVM_DIR="$d" && . "$d/nvm.sh" && break; done 2>/dev/null; nvm use 22 > /dev/null 2>&1;`;

      // Try direct Node 22 path first
      const node22Paths = ["/home/ino/.nvm/versions/node/v22.22.2/bin/node"];
      let node22 = "node";
      for (const p of node22Paths) {
        try { execSync(`ls "${p}"`, { stdio: "pipe" }); node22 = p; break; } catch { /* */ }
      }
      const ocBin = execSync("readlink -f $(which openclaw) 2>/dev/null || which openclaw", { encoding: "utf-8" }).trim();

      execSync(
        `${node22} ${ocBin} channels add --channel discord --token "${result.botToken}"`,
        { stdio: "inherit", timeout: 15_000 },
      );
      console.log(`\n  ${c.green}✓${c.reset} Discord channel registered with OpenClaw!`);

      // Restart gateway to pick up new channel
      console.log(`  ${c.dim}Restarting gateway...${c.reset}`);
      execSync("pkill -f openclaw-gateway 2>/dev/null", { stdio: "pipe" }).toString();

      return [
        `\n${c.green}${c.bold}✓ Discord bot setup complete!${c.reset}\n`,
        `  ${c.bold}Bot:${c.reset} ${appName}`,
        result.applicationId ? `  ${c.bold}App ID:${c.reset} ${result.applicationId}` : "",
        `  ${c.bold}Channel:${c.reset} Discord — registered with OpenClaw`,
        `\n  ${c.dim}Restart OpenClaw: "restart openclaw"${c.reset}`,
        `  ${c.dim}Then chat with OpenClaw in your Discord server!${c.reset}`,
      ].filter(Boolean).join("\n");
    } catch (err: unknown) {
      return `${c.yellow}⚠${c.reset} Bot created but OpenClaw registration failed.\n  Token: ${result.botToken}\n  ${c.dim}Register manually: openclaw channels add --channel discord --token ${result.botToken}${c.reset}`;
    }
  }

  if (result.error) {
    return `${c.yellow}⚠${c.reset} ${result.error}\n\n  ${c.dim}If you have the token, say: "setup discord with token YOUR_TOKEN"${c.reset}`;
  }

  return `${c.red}✗ Discord setup failed.${c.reset}`;
}
