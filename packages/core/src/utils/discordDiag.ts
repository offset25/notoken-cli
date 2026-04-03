/**
 * Discord bot diagnostics, setup, and auto-fix.
 *
 * `diagnoseDiscord()` — runs full checklist and auto-fixes everything:
 *   1. Token valid?
 *   2. Bot in guilds? → auto-invite via patchright
 *   3. Intents enabled in OpenClaw config? → auto-fix
 *   4. DM/group policy correct? → auto-fix
 *   5. OpenClaw version check
 *   6. Restart gateway if config changed
 *   7. Poll gateway connection up to 60s
 *   8. If 4014 error → enable intents via patchright → restart → re-poll
 *   9. Check channels
 *  10. Auto-approve pairing codes
 *  11. Send test message + verify response
 *
 * The full chain runs end-to-end without stopping.
 * User only needs to handle captcha/MFA when patchright prompts.
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
  const found = tryExec('ls /home/ino/.nvm/versions/node/v22*/bin/node 2>/dev/null | tail -1');
  return found || "node";
}

function getOcBin(): string {
  const node22 = getNode22();
  const nvmOc = tryExec(`ls ${node22.replace('/bin/node', '/lib/node_modules/openclaw/openclaw.mjs')} 2>/dev/null`);
  if (nvmOc) return nvmOc;
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

function getDiscordToken(): string {
  const config = tryExec("cat /root/.openclaw/openclaw.json 2>/dev/null");
  if (!config) return "";
  try {
    const parsed = JSON.parse(config);
    return parsed?.channels?.discord?.token
      ?? parsed?.channels?.discord?.accounts?.default?.token
      ?? "";
  } catch { return ""; }
}

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Restart the OpenClaw gateway and return true if health check passes.
 */
function restartGateway(): boolean {
  tryExec("pkill -f openclaw-gateway 2>/dev/null; pkill -f 'openclaw.*gateway' 2>/dev/null");
  tryExec("sleep 2");
  const node22 = getNode22();
  const ocBin = getOcBin();
  tryExec(`bash -c 'OLLAMA_API_KEY="ollama-local" nohup ${node22} ${ocBin} gateway --force --allow-unconfigured > /tmp/openclaw-start.log 2>&1 &'`);
  // Quick health poll — 15s
  for (let i = 0; i < 15; i++) {
    tryExec("sleep 1");
    const health = tryExec("curl -sf http://127.0.0.1:18789/health 2>/dev/null");
    if (health.includes('"ok"')) return true;
  }
  return false;
}

/**
 * Check gateway logs for current Discord connection state.
 * Returns snapshot — does not poll.
 */
function checkGatewayLogs(): { connected: boolean; error4014: boolean; rateLimited: boolean; retryAfter: number; awaiting: boolean } {
  const logFile = tryExec("ls /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null");
  if (!logFile) return { connected: false, error4014: false, rateLimited: false, retryAfter: 0, awaiting: false };

  const recentLogs = tryExec(`tail -50 "${logFile}" 2>/dev/null`);

  // Check if connected (and it's the most recent state, not stale)
  const lastLoggedIn = recentLogs.lastIndexOf("logged in to discord");
  const lastAwaiting = recentLogs.lastIndexOf("awaiting gateway readiness");
  if (lastLoggedIn > -1 && lastLoggedIn > lastAwaiting) {
    return { connected: true, error4014: false, rateLimited: false, retryAfter: 0, awaiting: false };
  }

  const error4014 = recentLogs.includes("4014");
  const rateLimited = recentLogs.includes("rate limited") || recentLogs.includes("status=429");

  // Extract retry_after if present
  let retryAfter = 0;
  const retryMatch = recentLogs.match(/retry_after[":]*\s*([\d.]+)/);
  if (retryMatch) retryAfter = Math.ceil(parseFloat(retryMatch[1]));

  const awaiting = recentLogs.includes("awaiting gateway readiness");

  return { connected: false, error4014, rateLimited, retryAfter, awaiting };
}

/**
 * Poll gateway logs for Discord connection, up to `maxSeconds`.
 * Returns { connected, error4014, stuck, rateLimited }.
 */
function pollGatewayConnection(maxSeconds = 60): { connected: boolean; error4014: boolean; stuck: boolean; rateLimited: boolean } {
  for (let elapsed = 0; elapsed < maxSeconds; elapsed += 3) {
    const status = checkGatewayLogs();
    if (status.connected) return { connected: true, error4014: false, stuck: false, rateLimited: false };
    if (status.error4014) return { connected: false, error4014: true, stuck: false, rateLimited: false };
    if (status.rateLimited && elapsed % 15 === 0 && elapsed > 0) {
      process.stdout.write(`  ${c.yellow}Rate limited by Discord — waiting for cooldown... ${elapsed}s${c.reset}\n`);
    }
    if (elapsed > 0 && elapsed % 15 === 0) {
      process.stdout.write(`  ${c.dim}Waiting for Discord connection... ${elapsed}s${c.reset}\n`);
    }
    tryExec("sleep 3");
  }
  // Final check
  const finalStatus = checkGatewayLogs();
  return {
    connected: false,
    error4014: finalStatus.error4014,
    stuck: !finalStatus.rateLimited,
    rateLimited: finalStatus.rateLimited,
  };
}

/**
 * Monitor a rate-limited gateway, reporting progress until connected or timeout.
 * Restarts the gateway once after the rate limit cooldown, then monitors.
 * Returns lines to append and whether it connected.
 */
async function monitorRateLimit(maxMinutes = 5): Promise<{ connected: boolean; lines: string[] }> {
  const out: string[] = [];
  const startTime = Date.now();
  const maxMs = maxMinutes * 60_000;
  let restarted = false;
  let lastRestart = 0;

  out.push(`  ${c.cyan}Monitoring rate limit recovery (up to ${maxMinutes} min)...${c.reset}`);

  while (Date.now() - startTime < maxMs) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const status = checkGatewayLogs();

    if (status.connected) {
      out.push(`  ${c.green}✓${c.reset} Discord connected after ${elapsed}s`);
      return { connected: true, lines: out };
    }

    // If rate limit has cleared (no more 429 in logs) and we haven't restarted recently, restart once
    if (!status.rateLimited && status.awaiting && !restarted && (Date.now() - lastRestart > 60_000)) {
      out.push(`  ${c.dim}Rate limit appears cleared — restarting gateway...${c.reset}`);
      restartGateway();
      restarted = true;
      lastRestart = Date.now();
      // Give it time to connect
      tryExec("sleep 10");
      continue;
    }

    // After a restart, check if it connected
    if (restarted && (Date.now() - lastRestart > 30_000)) {
      const postRestart = checkGatewayLogs();
      if (postRestart.connected) {
        out.push(`  ${c.green}✓${c.reset} Discord connected after restart (${elapsed}s total)`);
        return { connected: true, lines: out };
      }
      if (postRestart.rateLimited) {
        out.push(`  ${c.yellow}Still rate limited after restart — continuing to wait...${c.reset}`);
        restarted = false; // Allow another restart later
      }
    }

    if (elapsed % 30 === 0 && elapsed > 0) {
      const remaining = Math.round((maxMs - (Date.now() - startTime)) / 1000);
      if (status.rateLimited) {
        const retryInfo = status.retryAfter > 0 ? ` (retry_after: ${status.retryAfter}s)` : "";
        out.push(`  ${c.yellow}⏳${c.reset} Rate limited${retryInfo} — ${remaining}s remaining`);
      } else {
        out.push(`  ${c.dim}Still waiting... ${remaining}s remaining${c.reset}`);
      }
    }

    tryExec("sleep 5");
  }

  out.push(`  ${c.yellow}⚠${c.reset} Timed out after ${maxMinutes} minutes`);
  return { connected: false, lines: out };
}

/**
 * Test if the bot can send a DM via REST API.
 * Sends a test message to a guild member and checks if it went through.
 */
async function testBotDM(token: string, botId: string): Promise<boolean> {
  try {
    // Get guilds and find a human member to DM
    const guilds = await discordApi("/users/@me/guilds", token);
    if (!Array.isArray(guilds) || guilds.length === 0) return false;

    const members = await discordApi(`/guilds/${guilds[0].id}/members?limit=10`, token);
    if (!Array.isArray(members)) return false;

    const human = members.find((m: any) => !m.user?.bot);
    if (!human?.user?.id) return false;

    // Open DM channel
    const dmChannel = await discordApi("/users/@me/channels", token, "POST",
      JSON.stringify({ recipient_id: human.user.id }));
    if (!dmChannel?.id) return false;

    // Send test message
    const testMsg = await discordApi(`/channels/${dmChannel.id}/messages`, token, "POST",
      JSON.stringify({ content: `[notoken diagnostic] Bot communication test — ${new Date().toLocaleTimeString()}` }));

    if (testMsg?.id) {
      // Clean up test message
      await discordApi(`/channels/${dmChannel.id}/messages/${testMsg.id}`, token, "DELETE").catch(() => {});
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Full Discord diagnostic and auto-fix chain.
 */
export async function diagnoseDiscord(): Promise<string> {
  const results: DiagResult[] = [];
  const lines: string[] = [];
  let needsRestart = false;
  let token = "";

  lines.push(`\n${c.bold}${c.cyan}══════════════════════════════════════${c.reset}`);
  lines.push(`${c.bold}${c.cyan}  Discord Bot Diagnostics & Auto-Fix${c.reset}`);
  lines.push(`${c.bold}${c.cyan}══════════════════════════════════════${c.reset}\n`);

  // ── 1. Token valid? ──
  token = getDiscordToken();
  if (!token) {
    const savedResult = tryExec("cat /mnt/c/temp/discord-bot-result.json 2>/dev/null");
    try { token = JSON.parse(savedResult)?.token ?? ""; } catch {}
  }

  if (!token) {
    results.push({ name: "Bot token", status: "fail", detail: "No token found" });
    lines.push(`  ${c.red}✗${c.reset} ${c.bold}Bot token:${c.reset} Not configured`);
    lines.push(`    ${c.dim}Run: "setup discord" to create a bot and get a token${c.reset}`);
    return lines.join("\n") + `\n\n  ${c.red}Cannot continue without a token.${c.reset}`;
  }

  const botInfo = await discordApi("/users/@me", token);
  if (botInfo.error) {
    results.push({ name: "Bot token", status: "fail", detail: `Invalid: ${botInfo.error}` });
    lines.push(`  ${c.red}✗${c.reset} ${c.bold}Bot token:${c.reset} Invalid — ${botInfo.error}`);
    lines.push(`    ${c.dim}Run: "setup discord" to get a new token${c.reset}`);
    return lines.join("\n") + `\n\n  ${c.red}Cannot continue with invalid token.${c.reset}`;
  }

  const botName = botInfo.username ?? "unknown";
  const appId = botInfo.id;
  results.push({ name: "Bot token", status: "pass", detail: `${botName} (${appId})` });
  lines.push(`  ${c.green}✓${c.reset} ${c.bold}Bot token:${c.reset} Valid — ${c.bold}${botName}${c.reset} (${appId})`);

  // ── 2. Bot in guilds? ──
  let guilds = await discordApi("/users/@me/guilds", token);
  if (!Array.isArray(guilds) || guilds.length === 0) {
    results.push({ name: "Guilds", status: "fail", detail: "Not in any servers" });
    lines.push(`  ${c.red}✗${c.reset} ${c.bold}Guilds:${c.reset} Bot not in any servers`);
    lines.push(`    ${c.yellow}→ Auto-inviting via patchright...${c.reset}`);

    // Auto-fix: invite via patchright
    let authorized = false;
    try {
      const { authorizeDiscordBot } = await import("../automation/discordPatchright.js");
      authorized = await authorizeDiscordBot(appId);
    } catch (e: any) {
      lines.push(`    ${c.dim}Patchright unavailable: ${e.message?.substring(0, 50)}${c.reset}`);
      // Fallback: open URL in browser
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=68608&scope=bot`;
      tryExec(`/mnt/c/Windows/System32/cmd.exe /c "start ${inviteUrl}" 2>/dev/null`);
      lines.push(`    ${c.dim}Opened invite URL — add bot to server, then re-run this.${c.reset}`);
    }

    if (authorized) {
      // Wait for guild to appear in API
      lines.push(`    ${c.dim}Waiting for guild to register...${c.reset}`);
      for (let i = 0; i < 10; i++) {
        await sleep(3000);
        guilds = await discordApi("/users/@me/guilds", token);
        if (Array.isArray(guilds) && guilds.length > 0) break;
      }
      if (Array.isArray(guilds) && guilds.length > 0) {
        results.push({ name: "Guilds (fixed)", status: "fixed", detail: `Joined ${guilds[0].name}` });
        lines.push(`  ${c.green}✓${c.reset} ${c.bold}Guilds:${c.reset} Joined ${c.bold}${guilds[0].name}${c.reset}`);
      } else {
        lines.push(`  ${c.yellow}⚠${c.reset} Authorization succeeded but guild not yet visible — may need a moment.`);
      }
    }
  } else {
    results.push({ name: "Guilds", status: "pass", detail: `${guilds.length} server(s)` });
    lines.push(`  ${c.green}✓${c.reset} ${c.bold}Guilds:${c.reset} ${guilds.length} server(s)`);
    for (const g of guilds) {
      lines.push(`    ${c.cyan}•${c.reset} ${g.name} (${g.id})`);
    }
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
    ocCmd('config set channels.discord.intents \'{"presence":true,"guildMembers":true}\' --strict-json');
    results.push({ name: "Intents config", status: "fixed", detail: "Enabled presence + guildMembers" });
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
    results.push({ name: "Policies", status: "fixed", detail: "Set to open" });
    lines.push(`  ${c.yellow}⚡${c.reset} ${c.bold}Policies:${c.reset} Fixed — set to open`);
    needsRestart = true;
  }

  // ── 5. OpenClaw version ──
  const ocVersion = ocCmd("--version").replace(/^OpenClaw\s*/i, "").split(" ")[0];
  const npm = getNode22().replace('/bin/node', '/bin/npm');
  const latestVersion = tryExec(`${getNode22()} ${npm} view openclaw version 2>/dev/null`);

  if (ocVersion && latestVersion && ocVersion === latestVersion) {
    results.push({ name: "OpenClaw version", status: "pass", detail: `v${ocVersion}` });
    lines.push(`  ${c.green}✓${c.reset} ${c.bold}OpenClaw:${c.reset} v${ocVersion} (latest)`);
  } else if (ocVersion) {
    results.push({ name: "OpenClaw version", status: "warn", detail: `v${ocVersion} → ${latestVersion}` });
    lines.push(`  ${c.yellow}⚠${c.reset} ${c.bold}OpenClaw:${c.reset} v${ocVersion} (latest: ${latestVersion})`);
  } else {
    results.push({ name: "OpenClaw version", status: "fail", detail: "Cannot determine" });
    lines.push(`  ${c.red}✗${c.reset} ${c.bold}OpenClaw:${c.reset} Cannot determine version`);
  }

  // ── 6. Restart gateway if config changed ──
  if (needsRestart) {
    lines.push(`\n  ${c.cyan}Restarting OpenClaw gateway...${c.reset}`);
    const up = restartGateway();
    lines.push(up
      ? `  ${c.green}✓${c.reset} Gateway restarted`
      : `  ${c.yellow}⚠${c.reset} Gateway may still be starting...`
    );
  }

  // ── 7. Poll for Discord connection (up to 60s) ──
  lines.push(`\n  ${c.dim}Checking Discord connection...${c.reset}`);
  let connStatus = pollGatewayConnection(60);

  // ── 8. If 4014 error → enable intents via patchright → restart → re-poll ──
  if (connStatus.error4014) {
    results.push({ name: "Discord gateway", status: "fail", detail: "Error 4014 — intents not enabled on Developer Portal" });
    lines.push(`  ${c.red}✗${c.reset} ${c.bold}Discord gateway:${c.reset} Error 4014 — intents not enabled on Developer Portal`);
    lines.push(`    ${c.yellow}→ Auto-enabling intents via patchright...${c.reset}`);

    let intentsFixed = false;
    try {
      const { enableDiscordIntents } = await import("../automation/discordPatchright.js");
      intentsFixed = await enableDiscordIntents(appId);
    } catch (e: any) {
      lines.push(`    ${c.dim}Patchright unavailable: ${e.message?.substring(0, 50)}${c.reset}`);
      // Fallback: open portal
      tryExec(`/mnt/c/Windows/System32/cmd.exe /c "start https://discord.com/developers/applications/${appId}/bot" 2>/dev/null`);
      lines.push(`    ${c.dim}Opened Developer Portal — enable all Privileged Gateway Intents, then re-run.${c.reset}`);
    }

    if (intentsFixed) {
      lines.push(`    ${c.green}✓${c.reset} Intents enabled on Developer Portal`);
      lines.push(`  ${c.cyan}Restarting gateway after intent fix...${c.reset}`);
      restartGateway();
      // Re-poll
      connStatus = pollGatewayConnection(60);
    }
  }

  if (connStatus.connected) {
    results.push({ name: "Discord gateway", status: "pass", detail: "Connected" });
    lines.push(`  ${c.green}✓${c.reset} ${c.bold}Discord gateway:${c.reset} Connected`);
  } else if (connStatus.rateLimited) {
    // ── Rate limited — explain clearly and monitor ──
    const logStatus = checkGatewayLogs();
    lines.push(`  ${c.yellow}⚠${c.reset} ${c.bold}Discord gateway:${c.reset} ${c.yellow}Rate limited by Discord${c.reset}`);
    lines.push(``);
    lines.push(`    ${c.bold}What happened:${c.reset} Too many gateway restarts triggered Discord's rate limit`);
    lines.push(`    on the slash command deployment endpoint (/applications/{id}/commands).`);
    lines.push(`    OpenClaw's gateway hangs at "awaiting readiness" because it doesn't`);
    lines.push(`    retry after a 429 — it just stops.`);
    if (logStatus.retryAfter > 0) {
      lines.push(`    ${c.bold}Discord says:${c.reset} retry after ${c.yellow}${logStatus.retryAfter}s${c.reset}`);
    }
    lines.push(``);
    lines.push(`    ${c.bold}What we're doing:${c.reset} Monitoring until the rate limit clears, then`);
    lines.push(`    restarting the gateway once. Bot REST API (send DMs, check guilds)`);
    lines.push(`    still works — only the WebSocket listener is affected.`);
    lines.push(``);

    // Monitor and wait for it to resolve
    const monitor = await monitorRateLimit(5);
    lines.push(...monitor.lines);

    if (monitor.connected) {
      results.push({ name: "Discord gateway", status: "fixed", detail: "Connected after rate limit cleared" });
      connStatus = { connected: true, error4014: false, stuck: false, rateLimited: false };
    } else {
      // Still not connected — verify REST API at least works
      lines.push(`  ${c.dim}Testing bot communication via REST API...${c.reset}`);
      const canSendDM = await testBotDM(token, appId);
      if (canSendDM) {
        results.push({ name: "Discord gateway", status: "warn", detail: "Rate limited — REST API works, WebSocket still recovering" });
        lines.push(`  ${c.green}✓${c.reset} Bot can still send DMs via REST API`);
        lines.push(`    ${c.dim}The rate limit hasn't fully cleared yet. The gateway will recover`);
        lines.push(`    on its own — run "diagnose discord" again in a few minutes.${c.reset}`);
      } else {
        results.push({ name: "Discord gateway", status: "fail", detail: "Rate limited and REST API not working" });
        lines.push(`  ${c.red}✗${c.reset} Rate limited and REST API not responding`);
      }
    }
  } else if (connStatus.stuck) {
    // ── Stuck but not rate limited — check if gateway is running ──
    const health = tryExec("curl -sf http://127.0.0.1:18789/health 2>/dev/null");
    const gwUp = health.includes('"ok"');
    if (!gwUp) {
      // Gateway not running — start it
      lines.push(`  ${c.red}✗${c.reset} ${c.bold}Discord gateway:${c.reset} Not running — starting...`);
      const started = restartGateway();
      if (started) {
        const retry = pollGatewayConnection(60);
        if (retry.connected) {
          results.push({ name: "Discord gateway", status: "fixed", detail: "Started and connected" });
          lines.push(`  ${c.green}✓${c.reset} Gateway started and connected to Discord`);
          connStatus = retry;
        } else {
          results.push({ name: "Discord gateway", status: "warn", detail: "Started but still connecting" });
          lines.push(`  ${c.yellow}⚠${c.reset} Gateway started but still connecting — may need more time`);
        }
      } else {
        results.push({ name: "Discord gateway", status: "fail", detail: "Failed to start" });
        lines.push(`  ${c.red}✗${c.reset} Failed to start gateway`);
      }
    } else {
      // Gateway running but stuck — check for hidden rate limit in logs
      const logStatus = checkGatewayLogs();
      if (logStatus.rateLimited) {
        // Actually rate limited — redirect to monitor
        lines.push(`  ${c.yellow}⚠${c.reset} ${c.bold}Discord gateway:${c.reset} ${c.yellow}Rate limited by Discord${c.reset}`);
        lines.push(`    ${c.dim}Monitoring until rate limit clears...${c.reset}`);
        const monitor = await monitorRateLimit(5);
        lines.push(...monitor.lines);
        if (monitor.connected) {
          results.push({ name: "Discord gateway", status: "fixed", detail: "Connected after rate limit cleared" });
          connStatus = { connected: true, error4014: false, stuck: false, rateLimited: false };
        } else {
          results.push({ name: "Discord gateway", status: "warn", detail: "Rate limited — waiting for recovery" });
        }
      } else {
        // Genuinely stuck — restart once
        lines.push(`  ${c.yellow}⚠${c.reset} ${c.bold}Discord gateway:${c.reset} Stuck — restarting...`);
        restartGateway();
        const retry = pollGatewayConnection(45);
        if (retry.connected) {
          results.push({ name: "Discord gateway", status: "fixed", detail: "Connected after restart" });
          lines.push(`  ${c.green}✓${c.reset} Connected after restart`);
          connStatus = retry;
        } else {
          results.push({ name: "Discord gateway", status: "warn", detail: "Still not connected after restart" });
          lines.push(`  ${c.yellow}⚠${c.reset} Still not connected — run "diagnose discord" again in a few minutes`);
        }
      }
    }
  } else if (!connStatus.error4014) {
    results.push({ name: "Discord gateway", status: "warn", detail: "Status unclear" });
    lines.push(`  ${c.yellow}⚠${c.reset} ${c.bold}Discord gateway:${c.reset} Status unclear — check logs`);
  }

  // ── 9. Channels ──
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
    }
  }

  // ── 10. Pairing — find pending codes and auto-approve ──
  if (Array.isArray(guilds) && guilds.length > 0) {
    lines.push(`\n  ${c.bold}Checking pairing...${c.reset}`);

    const guildId = guilds[0].id;
    const members = await discordApi(`/guilds/${guildId}/members?limit=10`, token);
    let pairingHandled = false;

    if (Array.isArray(members)) {
      const humans = members.filter((m: any) => !m.user?.bot);
      for (const member of humans) {
        const userId = member.user?.id;
        if (!userId) continue;

        // Open DM channel
        const dmChannel = await discordApi("/users/@me/channels", token, "POST", JSON.stringify({ recipient_id: userId }));
        if (!dmChannel?.id) continue;

        // Read recent DMs
        const dms = await discordApi(`/channels/${dmChannel.id}/messages?limit=10`, token);
        if (!Array.isArray(dms)) continue;

        for (const dm of dms) {
          if (dm.author?.id !== botInfo.id) continue;
          const match = dm.content?.match(/(?:Pairing code|pairing code|code):\s*```?\s*(\w{6,12})\s*```?/i)
            ?? dm.content?.match(/\b([A-Z0-9]{6,12})\b/);
          if (!match) continue;

          const pairingCode = match[1];
          lines.push(`    ${c.yellow}⚡${c.reset} Found pairing code ${c.bold}${pairingCode}${c.reset} for ${member.user.username}`);

          // Auto-approve using correct binary
          const approveResult = ocCmd(`pairing approve discord ${pairingCode}`);
          if (approveResult.toLowerCase().includes("approved") || approveResult.toLowerCase().includes("success") || approveResult === "") {
            // Empty result can mean already approved
            const verifyResult = ocCmd("pairing list discord");
            if (verifyResult.toLowerCase().includes(pairingCode.toLowerCase()) || verifyResult.toLowerCase().includes("approved")) {
              lines.push(`    ${c.green}✓${c.reset} Auto-approved pairing for ${member.user.username}`);
              results.push({ name: "Pairing", status: "fixed", detail: `Approved ${pairingCode}` });
              pairingHandled = true;
            } else {
              lines.push(`    ${c.green}✓${c.reset} Pairing approve sent for ${member.user.username}`);
              pairingHandled = true;
            }
          } else {
            lines.push(`    ${c.yellow}⚠${c.reset} Approve result: ${approveResult.substring(0, 80)}`);
            results.push({ name: "Pairing", status: "warn", detail: approveResult.substring(0, 60) });
          }
          break;
        }
        if (pairingHandled) break;
      }
    }

    if (!pairingHandled) {
      // Check if pairing is already done
      const pairingList = ocCmd("pairing list discord");
      if (pairingList.includes("approved") || pairingList.includes("paired")) {
        results.push({ name: "Pairing", status: "pass", detail: "Already paired" });
        lines.push(`  ${c.green}✓${c.reset} ${c.bold}Pairing:${c.reset} Already paired`);
      } else {
        lines.push(`  ${c.dim}No pending pairing codes found. DM the bot to trigger pairing.${c.reset}`);
      }
    }
  }

  // ── 11. Test message — send and verify response ──
  if (connStatus.connected && Array.isArray(guilds) && guilds.length > 0) {
    const guildId = guilds[0].id;
    const channels = await discordApi(`/guilds/${guildId}/channels`, token);
    if (Array.isArray(channels)) {
      const textChannel = channels.find((ch: any) => ch.type === 0);
      if (textChannel) {
        lines.push(`\n  ${c.bold}Testing bot response...${c.reset}`);

        // Send a test message mentioning the bot
        const testMsg = `<@${appId}> notoken diagnostic ping`;
        const sent = await discordApi(`/channels/${textChannel.id}/messages`, token, "POST",
          JSON.stringify({ content: testMsg }));

        if (sent?.id) {
          lines.push(`  ${c.dim}Sent test ping to #${textChannel.name}...${c.reset}`);
          // Wait a few seconds for bot to respond
          await sleep(5000);
          // Check for response
          const recent = await discordApi(`/channels/${textChannel.id}/messages?limit=5&after=${sent.id}`, token);
          if (Array.isArray(recent) && recent.length > 0) {
            results.push({ name: "Bot response", status: "pass", detail: "Bot responded!" });
            lines.push(`  ${c.green}✓${c.reset} ${c.bold}Bot response:${c.reset} Bot is responding in #${textChannel.name}!`);
          } else {
            results.push({ name: "Bot response", status: "warn", detail: "No response yet — may need pairing" });
            lines.push(`  ${c.yellow}⚠${c.reset} ${c.bold}Bot response:${c.reset} No response yet — may need pairing first`);
            lines.push(`    ${c.dim}DM the bot directly to trigger pairing, then re-run diagnostics.${c.reset}`);
          }
          // Clean up test message
          await discordApi(`/channels/${textChannel.id}/messages/${sent.id}`, token, "DELETE").catch(() => {});
        } else {
          lines.push(`  ${c.dim}Could not send test message — bot may lack permissions.${c.reset}`);
        }
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
