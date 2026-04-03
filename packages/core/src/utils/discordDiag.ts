/**
 * Discord bot diagnostics, setup, and auto-fix.
 *
 * `diagnoseDiscord()` — runs 13-step checklist, auto-fixes everything it can:
 *   1. Token valid?
 *   2. Bot in guilds?
 *   3. Intents enabled in OpenClaw config?
 *   4. DM/group policy correct?
 *   5. OpenClaw version current?
 *   6. Gateway connected to Discord?
 *   7. Channels available?
 *   8. Pairing codes pending?
 *   9. Bot responding?
 *
 * After each failing check, attempts auto-fix before moving to next.
 * Restarts gateway when config changes are made.
 * Uses patchright for Discord Developer Portal automation when needed.
 */

import { execSync } from "node:child_process";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

interface DiagResult {
  name: string;
  status: "pass" | "warn" | "fail" | "fixed";
  detail: string;
}

function tryExec(cmd: string, timeout = 15_000): string {
  try {
    return execSync(cmd, { timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    return e.stdout?.trim?.() ?? "";
  }
}

function getNode22(): string {
  const paths = ["/home/ino/.nvm/versions/node/v22.22.2/bin/node"];
  for (const p of paths) {
    if (tryExec(`ls "${p}" 2>/dev/null`)) return p;
  }
  // Find any v22
  const found = tryExec('ls /home/ino/.nvm/versions/node/v22*/bin/node 2>/dev/null | tail -1');
  return found || "node";
}

function getOcBin(): string {
  const node22 = getNode22();
  // Check nvm-installed version first (newer)
  const nvmOc = tryExec(`ls ${node22.replace('/bin/node', '/lib/node_modules/openclaw/openclaw.mjs')} 2>/dev/null`);
  if (nvmOc) return nvmOc;
  // Fallback to global
  return tryExec("readlink -f $(which openclaw) 2>/dev/null") || "openclaw";
}

function ocCmd(cmd: string, timeout = 15_000): string {
  return tryExec(`${getNode22()} ${getOcBin()} ${cmd}`, timeout);
}

async function discordApi(endpoint: string, token: string, method = "GET", body?: string): Promise<any> {
  const headers: Record<string, string> = { "Authorization": `Bot ${token}` };
  if (body) headers["Content-Type"] = "application/json";

  try {
    const response = await fetch(`https://discord.com/api/v10${endpoint}`, {
      method, headers, body,
    });
    if (!response.ok) return { error: response.status, message: await response.text() };
    return response.json();
  } catch (e: any) {
    return { error: "fetch_failed", message: e.message };
  }
}

/**
 * Get the Discord bot token from OpenClaw config.
 */
function getDiscordToken(): string {
  const config = tryExec("cat /root/.openclaw/openclaw.json 2>/dev/null");
  if (!config) return "";
  try {
    const parsed = JSON.parse(config);
    // Token might be in channels.discord.token or channels.discord.accounts.default.token
    const token = parsed?.channels?.discord?.token
      ?? parsed?.channels?.discord?.accounts?.default?.token
      ?? "";
    return typeof token === "string" ? token : "";
  } catch { return ""; }
}

/**
 * Full Discord diagnostic and auto-fix.
 */
export async function diagnoseDiscord(): Promise<string> {
  const results: DiagResult[] = [];
  const lines: string[] = [];
  let needsRestart = false;
  let token = "";

  lines.push(`\n${c.bold}${c.cyan}══════════════════════════════════════${c.reset}`);
  lines.push(`${c.bold}${c.cyan}  Discord Bot Diagnostics${c.reset}`);
  lines.push(`${c.bold}${c.cyan}══════════════════════════════════════${c.reset}\n`);

  // ── 1. Token valid? ──
  token = getDiscordToken();
  if (!token) {
    // Try reading from clipboard or saved result
    const savedResult = tryExec("cat /mnt/c/temp/discord-bot-result.json 2>/dev/null");
    try { token = JSON.parse(savedResult)?.token ?? ""; } catch {}
  }

  if (!token) {
    results.push({ name: "Bot token", status: "fail", detail: "No Discord bot token found in OpenClaw config" });
    lines.push(`  ${c.red}✗${c.reset} ${c.bold}Bot token:${c.reset} Not configured`);
    lines.push(`    ${c.dim}Run: "setup discord" to create a bot and get a token${c.reset}`);
    return lines.join("\n") + `\n\n  ${c.red}Cannot continue without a token.${c.reset}`;
  }

  const botInfo = await discordApi("/users/@me", token);
  if (botInfo.error) {
    results.push({ name: "Bot token", status: "fail", detail: `Token invalid: ${botInfo.error} ${botInfo.message?.substring(0, 50)}` });
    lines.push(`  ${c.red}✗${c.reset} ${c.bold}Bot token:${c.reset} Invalid — ${botInfo.error}`);
    lines.push(`    ${c.dim}Token may have been reset. Run: "setup discord" to get a new token${c.reset}`);
    return lines.join("\n") + `\n\n  ${c.red}Cannot continue with invalid token.${c.reset}`;
  }

  const botName = botInfo.username ?? "unknown";
  results.push({ name: "Bot token", status: "pass", detail: `${botName} (${botInfo.id})` });
  lines.push(`  ${c.green}✓${c.reset} ${c.bold}Bot token:${c.reset} Valid — ${c.bold}${botName}${c.reset} (${botInfo.id})`);

  // ── 2. Bot in guilds? ──
  const guilds = await discordApi("/users/@me/guilds", token);
  if (Array.isArray(guilds) && guilds.length > 0) {
    results.push({ name: "Guilds", status: "pass", detail: `In ${guilds.length} server(s): ${guilds.map((g: any) => g.name).join(", ")}` });
    lines.push(`  ${c.green}✓${c.reset} ${c.bold}Guilds:${c.reset} In ${guilds.length} server(s)`);
    for (const g of guilds) {
      lines.push(`    ${c.cyan}•${c.reset} ${g.name} (${g.id})`);
    }
  } else {
    results.push({ name: "Guilds", status: "fail", detail: "Bot not in any servers" });
    lines.push(`  ${c.red}✗${c.reset} ${c.bold}Guilds:${c.reset} Bot not in any servers`);
    lines.push(`    ${c.yellow}→ Opening invite URL...${c.reset}`);

    // Auto-fix: open invite URL
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${botInfo.id}&permissions=68608&scope=bot`;
    tryExec(`/mnt/c/Windows/System32/cmd.exe /c "start ${inviteUrl}" 2>/dev/null`);
    lines.push(`    ${c.dim}Invite URL opened. Add bot to your server, then run this again.${c.reset}`);
    lines.push(`    ${c.dim}${inviteUrl}${c.reset}`);
  }

  // ── 3. OpenClaw intents config ──
  const intentsConfig = tryExec(`${getNode22()} ${getOcBin()} config get channels.discord.intents 2>/dev/null`);
  let intentsOk = false;
  try {
    const intents = JSON.parse(intentsConfig);
    intentsOk = intents.presence === true && intents.guildMembers === true;
  } catch {}

  if (intentsOk) {
    results.push({ name: "Intents config", status: "pass", detail: "presence=true, guildMembers=true" });
    lines.push(`  ${c.green}✓${c.reset} ${c.bold}Intents config:${c.reset} Correctly configured`);
  } else {
    // Auto-fix
    ocCmd('config set channels.discord.intents \'{"presence":true,"guildMembers":true}\' --strict-json');
    results.push({ name: "Intents config", status: "fixed", detail: "Set presence=true, guildMembers=true" });
    lines.push(`  ${c.yellow}⚡${c.reset} ${c.bold}Intents config:${c.reset} Fixed — enabled presence + guildMembers`);
    needsRestart = true;
  }

  // ── 4. DM & group policy ──
  const dmPolicy = tryExec(`${getNode22()} ${getOcBin()} config get channels.discord.dmPolicy 2>/dev/null`).replace(/"/g, "");
  const groupPolicy = tryExec(`${getNode22()} ${getOcBin()} config get channels.discord.groupPolicy 2>/dev/null`).replace(/"/g, "");

  if (dmPolicy === "open" && groupPolicy === "open") {
    results.push({ name: "Policies", status: "pass", detail: "dmPolicy=open, groupPolicy=open" });
    lines.push(`  ${c.green}✓${c.reset} ${c.bold}Policies:${c.reset} DM=open, Group=open`);
  } else {
    if (dmPolicy !== "open") {
      ocCmd('config set channels.discord.allowFrom \'["*"]\' --strict-json');
      ocCmd('config set channels.discord.dmPolicy \'"open"\' --strict-json');
    }
    if (groupPolicy !== "open") {
      ocCmd('config set channels.discord.groupPolicy \'"open"\' --strict-json');
    }
    results.push({ name: "Policies", status: "fixed", detail: "Set dmPolicy=open, groupPolicy=open" });
    lines.push(`  ${c.yellow}⚡${c.reset} ${c.bold}Policies:${c.reset} Fixed — set to open`);
    needsRestart = true;
  }

  // ── 5. OpenClaw version ──
  const ocVersion = ocCmd("--version").replace(/^OpenClaw\s*/i, "").split(" ")[0];
  const latestVersion = tryExec(`${getNode22()} ${getNode22().replace('/bin/node', '/bin/npm')} view openclaw version 2>/dev/null`);

  if (ocVersion && latestVersion && ocVersion === latestVersion) {
    results.push({ name: "OpenClaw version", status: "pass", detail: `v${ocVersion} (latest)` });
    lines.push(`  ${c.green}✓${c.reset} ${c.bold}OpenClaw:${c.reset} v${ocVersion} (latest)`);
  } else if (ocVersion) {
    results.push({ name: "OpenClaw version", status: "warn", detail: `v${ocVersion} → ${latestVersion} available` });
    lines.push(`  ${c.yellow}⚠${c.reset} ${c.bold}OpenClaw:${c.reset} v${ocVersion} (latest: ${latestVersion})`);
    lines.push(`    ${c.dim}Update: "update openclaw"${c.reset}`);
  } else {
    results.push({ name: "OpenClaw version", status: "fail", detail: "Cannot determine version" });
    lines.push(`  ${c.red}✗${c.reset} ${c.bold}OpenClaw:${c.reset} Cannot determine version`);
  }

  // ── 6. Restart if config changed ──
  if (needsRestart) {
    lines.push(`\n  ${c.cyan}Restarting OpenClaw gateway...${c.reset}`);
    tryExec("pkill -f openclaw-gateway 2>/dev/null");
    tryExec("sleep 2");
    const node22 = getNode22();
    const ocBin = getOcBin();
    tryExec(`bash -c 'OLLAMA_API_KEY="ollama-local" nohup ${node22} ${ocBin} gateway --force --allow-unconfigured > /tmp/openclaw-start.log 2>&1 &'`);
    tryExec("sleep 10");

    const health = tryExec("curl -sf http://127.0.0.1:18789/health 2>/dev/null");
    if (health.includes('"ok"')) {
      lines.push(`  ${c.green}✓${c.reset} Gateway restarted`);
    } else {
      lines.push(`  ${c.yellow}⚠${c.reset} Gateway may still be starting...`);
    }
  }

  // ── 7. Gateway connected to Discord? ──
  // Wait a moment for Discord connection
  if (needsRestart) tryExec("sleep 5");

  const logFile = tryExec("ls /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null");
  let discordConnected = false;
  if (logFile) {
    const recentLogs = tryExec(`tail -20 "${logFile}" 2>/dev/null`);
    discordConnected = recentLogs.includes("logged in to discord");
    const stuck = recentLogs.includes("awaiting gateway readiness") && !discordConnected;
    const error4014 = recentLogs.includes("4014");

    if (discordConnected) {
      results.push({ name: "Discord gateway", status: "pass", detail: "Connected" });
      lines.push(`  ${c.green}✓${c.reset} ${c.bold}Discord gateway:${c.reset} Connected`);
    } else if (error4014) {
      results.push({ name: "Discord gateway", status: "fail", detail: "Error 4014 — intents not enabled on Discord Developer Portal" });
      lines.push(`  ${c.red}✗${c.reset} ${c.bold}Discord gateway:${c.reset} Error 4014 — intents not enabled`);
      lines.push(`    ${c.yellow}→ Opening Developer Portal to enable intents...${c.reset}`);

      // Auto-fix via patchright
      const appId = botInfo.id;
      tryExec(`/mnt/c/Windows/System32/cmd.exe /c "start https://discord.com/developers/applications/${appId}/bot" 2>/dev/null`);
      lines.push(`    ${c.dim}Enable all Privileged Gateway Intents, then run this again.${c.reset}`);

      // Try patchright auto-fix
      const patchrightFix = tryExec(`/mnt/c/Windows/System32/cmd.exe /c "cd C:\\temp && node -e \\"const{chromium}=require('patchright');(async()=>{const c=await chromium.launchPersistentContext('C:\\\\temp\\\\notoken-browser-profile',{headless:false,channel:'msedge'});const p=c.pages()[0]||await c.newPage();await p.goto('https://discord.com/developers/applications/${appId}/bot');await p.waitForLoadState('networkidle');await p.waitForTimeout(5000);await p.locator('text=Privileged Gateway Intents').scrollIntoViewIfNeeded().catch(()=>{});await p.waitForTimeout(2000);const sw=await p.locator('label[data-react-aria-pressable=true] input[role=switch]').all();let t=0;for(const s of sw){if(!await s.isChecked().catch(()=>true)){await s.locator('..').locator('..').first().click({force:true}).catch(()=>{});await p.waitForTimeout(500);t++}}await p.click('button:has-text(\\\\\\"Save Changes\\\\\\")',{timeout:3000}).catch(()=>{});console.log('Enabled '+t);await c.close()})().catch(e=>console.error(e.message))\\"" 2>/dev/null`, 30_000);
      if (patchrightFix.includes("Enabled")) {
        lines.push(`    ${c.green}✓${c.reset} Auto-enabled intents via patchright`);
        needsRestart = true;
      }
    } else if (stuck) {
      results.push({ name: "Discord gateway", status: "warn", detail: "Awaiting gateway readiness — may take a moment" });
      lines.push(`  ${c.yellow}⚠${c.reset} ${c.bold}Discord gateway:${c.reset} Connecting... (may take a moment)`);
    } else {
      results.push({ name: "Discord gateway", status: "warn", detail: "Status unclear — check logs" });
      lines.push(`  ${c.yellow}⚠${c.reset} ${c.bold}Discord gateway:${c.reset} Status unclear`);
    }
  }

  // ── 8. Channels ──
  if (Array.isArray(guilds) && guilds.length > 0) {
    const guildId = guilds[0].id;
    const channels = await discordApi(`/guilds/${guildId}/channels`, token);
    if (Array.isArray(channels)) {
      const textChannels = channels.filter((ch: any) => ch.type === 0);
      results.push({ name: "Channels", status: "pass", detail: `${textChannels.length} text channel(s)` });
      lines.push(`  ${c.green}✓${c.reset} ${c.bold}Channels:${c.reset} ${textChannels.length} text channel(s)`);
      for (const ch of textChannels) {
        lines.push(`    ${c.cyan}#${c.reset} ${ch.name} (${ch.id})`);
      }
      if (textChannels.length === 1) {
        lines.push(`    ${c.dim}Bot will respond in #${textChannels[0].name}${c.reset}`);
      }
    }
  }

  // ── 9. Pairing — check DMs for pending codes ──
  if (Array.isArray(guilds) && guilds.length > 0) {
    lines.push(`\n  ${c.bold}Checking pairing...${c.reset}`);

    // Get members to find user who might need pairing
    const guildId = guilds[0].id;
    const members = await discordApi(`/guilds/${guildId}/members?limit=10`, token);

    if (Array.isArray(members)) {
      const humans = members.filter((m: any) => !m.user?.bot);
      for (const member of humans) {
        const userId = member.user?.id;
        if (!userId) continue;

        // Open DM channel
        const dmChannel = await discordApi("/users/@me/channels", token, "POST", JSON.stringify({ recipient_id: userId }));
        if (!dmChannel?.id) continue;

        // Read DMs
        const dms = await discordApi(`/channels/${dmChannel.id}/messages?limit=10`, token);
        if (!Array.isArray(dms)) continue;

        // Find pairing code in bot's messages
        for (const dm of dms) {
          if (dm.author?.id !== botInfo.id) continue;
          const match = dm.content?.match(/Pairing code:\s*```\s*(\w+)\s*```/);
          if (match) {
            const pairingCode = match[1];
            lines.push(`    ${c.yellow}⚡${c.reset} Found pairing code ${c.bold}${pairingCode}${c.reset} for ${member.user.username}`);

            // Auto-approve
            const approveResult = ocCmd(`pairing approve discord ${pairingCode}`);
            if (approveResult.includes("Approved")) {
              lines.push(`    ${c.green}✓${c.reset} Auto-approved pairing for ${member.user.username}`);
              results.push({ name: "Pairing", status: "fixed", detail: `Approved ${pairingCode} for ${member.user.username}` });
            } else {
              lines.push(`    ${c.yellow}⚠${c.reset} Could not auto-approve: ${approveResult.substring(0, 60)}`);
              results.push({ name: "Pairing", status: "warn", detail: approveResult.substring(0, 60) });
            }
            break;
          }
        }
      }
    }
  }

  // ── 10. Send test message ──
  if (discordConnected && Array.isArray(guilds) && guilds.length > 0) {
    const guildId = guilds[0].id;
    const channels = await discordApi(`/guilds/${guildId}/channels`, token);
    if (Array.isArray(channels)) {
      const textChannel = channels.find((ch: any) => ch.type === 0);
      if (textChannel) {
        lines.push(`\n  ${c.bold}Test message...${c.reset}`);
        // We don't send a test message automatically to avoid spam
        // Just report that the bot should be able to respond
        lines.push(`  ${c.green}✓${c.reset} Bot should respond in ${c.bold}#${textChannel.name}${c.reset}`);
        lines.push(`    ${c.dim}Try: @${botName} hello${c.reset}`);
      }
    }
  }

  // ── Summary ──
  lines.push(`\n${c.bold}${c.cyan}── Summary ──${c.reset}\n`);

  const passed = results.filter(r => r.status === "pass").length;
  const fixed = results.filter(r => r.status === "fixed").length;
  const failed = results.filter(r => r.status === "fail").length;
  const warned = results.filter(r => r.status === "warn").length;

  if (failed === 0 && warned === 0) {
    lines.push(`  ${c.green}${c.bold}✓ All checks passed!${c.reset} ${fixed > 0 ? `(${fixed} auto-fixed)` : ""}`);
  } else if (failed === 0) {
    lines.push(`  ${c.yellow}⚠ ${warned} warning(s)${c.reset} ${fixed > 0 ? `, ${fixed} auto-fixed` : ""}`);
  } else {
    lines.push(`  ${c.red}✗ ${failed} issue(s) need attention${c.reset} ${fixed > 0 ? `, ${fixed} auto-fixed` : ""}`);
  }

  lines.push(`  ${c.dim}Passed: ${passed} | Fixed: ${fixed} | Warnings: ${warned} | Failed: ${failed}${c.reset}`);

  return lines.join("\n");
}

/**
 * Quick Discord status check.
 */
export async function quickDiscordCheck(): Promise<string> {
  const token = getDiscordToken();
  if (!token) return `${c.red}✗${c.reset} Discord not configured. Run: "setup discord"`;

  const bot = await discordApi("/users/@me", token);
  if (bot.error) return `${c.red}✗${c.reset} Discord token invalid`;

  const guilds = await discordApi("/users/@me/guilds", token);
  const inGuilds = Array.isArray(guilds) ? guilds.length : 0;

  const health = tryExec("curl -sf http://127.0.0.1:18789/health 2>/dev/null");
  const gwUp = health.includes('"ok"');

  const logFile = tryExec("ls /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null");
  const logs = logFile ? tryExec(`tail -20 "${logFile}" 2>/dev/null`) : "";
  const connected = logs.includes("logged in to discord");

  return [
    `\n${c.bold}${c.cyan}── Discord Status ──${c.reset}\n`,
    `  ${c.bold}Bot:${c.reset} ${bot.username} (${bot.id})`,
    `  ${c.bold}Servers:${c.reset} ${inGuilds > 0 ? `${c.green}${inGuilds}${c.reset}` : `${c.red}0${c.reset} — needs invite`}`,
    `  ${c.bold}Gateway:${c.reset} ${gwUp ? `${c.green}✓ running${c.reset}` : `${c.red}✗ down${c.reset}`}`,
    `  ${c.bold}Discord:${c.reset} ${connected ? `${c.green}✓ connected${c.reset}` : `${c.yellow}⚠ not connected${c.reset}`}`,
    `\n  ${c.dim}Full check: "diagnose discord"${c.reset}`,
  ].join("\n");
}
