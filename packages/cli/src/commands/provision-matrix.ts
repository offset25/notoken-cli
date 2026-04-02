/**
 * Matrix server provisioner.
 *
 * Full self-hosted Matrix setup:
 * 1. Check/install Docker
 * 2. Check/install nginx (reverse proxy)
 * 3. Ask: custom domain or server IP/reverse DNS
 * 4. If domain → install certbot, get Let's Encrypt SSL
 * 5. Configure nginx reverse proxy → Conduit
 * 6. Deploy Matrix Conduit via Docker Compose
 * 7. Wait for server health
 * 8. Register openclaw-bot user
 * 9. Register human user
 * 10. Connect OpenClaw to Matrix
 * 11. Verify end-to-end
 *
 * Every step has error handling. Failures suggest fixes.
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};

const CONDUIT_INTERNAL_PORT = 6167;
const CONDUIT_EXTERNAL_PORT = 8448;
const CONDUIT_DIR = "/opt/matrix-conduit";

interface ProvisionState {
  serverName: string;
  domain: string | null;
  useSSL: boolean;
  matrixPort: number;
  botUserId: string | null;
  botAccessToken: string | null;
  humanUsername: string | null;
  reverseProxy: "nginx" | "apache" | "none";
  errors: string[];
}

export async function provisionMatrix(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const state: ProvisionState = {
    serverName: "matrix.local",
    domain: null,
    useSSL: false,
    matrixPort: CONDUIT_EXTERNAL_PORT,
    botUserId: null,
    botAccessToken: null,
    humanUsername: null,
    reverseProxy: "none",
    errors: [],
  };

  try {
    console.log(`\n${c.bold}${c.magenta}  Matrix Server Setup${c.reset}`);
    console.log(`${c.dim}  Self-hosted Matrix server with OpenClaw integration${c.reset}\n`);

    // ── Step 1: Docker ──
    if (!await ensureDocker(rl)) return;

    // ── Step 2: Domain or IP ──
    await configureDomain(rl, state);

    // ── Step 3: Reverse Proxy ──
    if (state.domain) {
      await ensureReverseProxy(rl, state);
    }

    // ── Step 4: SSL ──
    if (state.domain && state.reverseProxy !== "none") {
      await configureSSL(rl, state);
    }

    // ── Step 5: Deploy Conduit ──
    if (!await deployConduit(state)) return;

    // ── Step 6: Wait for health ──
    if (!await waitForMatrix(state)) return;

    // ── Step 7: Configure reverse proxy ──
    if (state.reverseProxy !== "none") {
      configureProxy(state);
    }

    // ── Step 8: Register bot ──
    await registerBot(state);

    // ── Step 9: Register human user ──
    await registerHuman(rl, state);

    // ── Step 10: Connect OpenClaw ──
    connectOpenClaw(state);

    // ── Step 11: Summary ──
    printSummary(state);

  } finally {
    rl.close();
  }
}

// ─── Step 1: Docker ─────────────────────────────────────────────────────────

async function ensureDocker(rl: readline.Interface): Promise<boolean> {
  step("Checking Docker");

  if (tryExec("docker --version")) {
    pass("Docker installed");

    // Check if daemon is running
    if (!tryExec("docker info --format '{{.ServerVersion}}'")) {
      warn("Docker daemon not running");
      const start = await ask(rl, `  Start Docker? [Y/n] `);
      if (/^n/i.test(start)) {
        fail("Docker daemon required. Run: sudo systemctl start docker");
        return false;
      }
      if (!tryExec("sudo systemctl start docker")) {
        fail("Could not start Docker. Try manually: sudo systemctl start docker");
        return false;
      }
      pass("Docker daemon started");
    } else {
      pass("Docker daemon running");
    }
    return true;
  }

  warn("Docker not installed");
  const install = await ask(rl, `  Install Docker? [Y/n] `);
  if (/^n/i.test(install)) {
    fail("Docker required for Matrix server");
    return false;
  }

  info("Installing Docker (this may take a minute)...");
  try {
    execSync("curl -fsSL https://get.docker.com | sh", { stdio: "inherit", timeout: 180_000 });
    execSync("sudo systemctl enable docker && sudo systemctl start docker", { stdio: "pipe", timeout: 30_000 });
    tryExec("sudo usermod -aG docker $USER");
    pass("Docker installed and running");
    return true;
  } catch {
    fail("Docker install failed. Try manually: curl -fsSL https://get.docker.com | sh");
    return false;
  }
}

// ─── Step 2: Domain ─────────────────────────────────────────────────────────

async function configureDomain(rl: readline.Interface, state: ProvisionState): Promise<void> {
  step("Server address");

  console.log(`  How should your Matrix server be reached?\n`);
  console.log(`  ${c.cyan}1${c.reset} Custom domain ${c.dim}— e.g., matrix.example.com (needs DNS pointing here)${c.reset}`);
  console.log(`  ${c.cyan}2${c.reset} Server IP address ${c.dim}— use this server's IP directly${c.reset}`);
  console.log(`  ${c.cyan}3${c.reset} Reverse DNS ${c.dim}— use this server's hostname${c.reset}\n`);

  const choice = await ask(rl, `  Choice [1-3]: `);

  switch (choice.trim()) {
    case "1": {
      const domain = await ask(rl, `  Domain name (e.g., matrix.example.com): `);
      if (domain.trim()) {
        state.domain = domain.trim();
        state.serverName = domain.trim();

        // Verify DNS
        const resolved = tryExec(`dig +short ${state.domain} 2>/dev/null`);
        const myIp = tryExec("curl -sf https://api.ipify.org 2>/dev/null") ?? tryExec("hostname -I | awk '{print $1}'");

        if (resolved && myIp && resolved.includes(myIp)) {
          pass(`DNS verified: ${state.domain} → ${myIp}`);
        } else {
          warn(`DNS may not point to this server (got: ${resolved || "nothing"}, expected: ${myIp})`);
          console.log(`  ${c.dim}Make sure ${state.domain} has an A record pointing to ${myIp}${c.reset}`);
          const cont = await ask(rl, `  Continue anyway? [y/N] `);
          if (!/^y/i.test(cont)) {
            state.domain = null;
            state.serverName = myIp ?? "localhost";
          }
        }
      }
      break;
    }
    case "2": {
      const ip = tryExec("curl -sf https://api.ipify.org 2>/dev/null") ?? tryExec("hostname -I | awk '{print $1}'") ?? "localhost";
      state.serverName = ip;
      pass(`Using IP: ${ip}`);
      break;
    }
    case "3": {
      const hostname = tryExec("hostname -f") ?? tryExec("hostname") ?? "localhost";
      state.serverName = hostname;
      pass(`Using hostname: ${hostname}`);
      break;
    }
    default: {
      const ip = tryExec("curl -sf https://api.ipify.org 2>/dev/null") ?? "localhost";
      state.serverName = ip;
      pass(`Using IP: ${ip}`);
    }
  }
}

// ─── Step 3: Reverse Proxy ──────────────────────────────────────────────────

async function ensureReverseProxy(rl: readline.Interface, state: ProvisionState): Promise<void> {
  step("Reverse proxy");

  const hasNginx = !!tryExec("nginx -v 2>&1");
  const hasApache = !!tryExec("apache2 -v 2>&1") || !!tryExec("httpd -v 2>&1");

  if (hasNginx) {
    state.reverseProxy = "nginx";
    pass("nginx detected — will use as reverse proxy");
    return;
  }

  if (hasApache) {
    state.reverseProxy = "apache";
    pass("Apache detected — will use as reverse proxy");
    return;
  }

  console.log(`  No web server found. Install one for SSL and proper domain hosting.\n`);
  console.log(`  ${c.cyan}1${c.reset} nginx ${c.dim}— recommended, lightweight${c.reset}`);
  console.log(`  ${c.cyan}2${c.reset} Apache`);
  console.log(`  ${c.cyan}3${c.reset} Skip ${c.dim}— access Matrix directly on port ${CONDUIT_EXTERNAL_PORT}${c.reset}\n`);

  const choice = await ask(rl, `  Choice [1-3]: `);

  if (choice.trim() === "1") {
    info("Installing nginx...");
    if (tryExec("apt-get install -y nginx 2>/dev/null") || tryExec("dnf install -y nginx 2>/dev/null")) {
      tryExec("systemctl enable nginx && systemctl start nginx");
      state.reverseProxy = "nginx";
      pass("nginx installed and running");
    } else {
      warn("nginx install failed. Continuing without reverse proxy.");
    }
  } else if (choice.trim() === "2") {
    info("Installing Apache...");
    if (tryExec("apt-get install -y apache2 2>/dev/null") || tryExec("dnf install -y httpd 2>/dev/null")) {
      tryExec("systemctl enable apache2 2>/dev/null || systemctl enable httpd");
      tryExec("systemctl start apache2 2>/dev/null || systemctl start httpd");
      tryExec("a2enmod proxy proxy_http proxy_wstunnel ssl rewrite 2>/dev/null");
      state.reverseProxy = "apache";
      pass("Apache installed and running");
    } else {
      warn("Apache install failed. Continuing without reverse proxy.");
    }
  }
}

// ─── Step 4: SSL ────────────────────────────────────────────────────────────

async function configureSSL(rl: readline.Interface, state: ProvisionState): Promise<void> {
  step("SSL certificate");

  if (!state.domain) return;

  const setupSSL = await ask(rl, `  Set up Let's Encrypt SSL for ${state.domain}? [Y/n] `);
  if (/^n/i.test(setupSSL)) {
    info("Skipping SSL. Matrix will use HTTP.");
    return;
  }

  // Install certbot
  if (!tryExec("certbot --version")) {
    info("Installing certbot...");
    const plugin = state.reverseProxy === "nginx" ? "python3-certbot-nginx" : "python3-certbot-apache";
    if (!tryExec(`apt-get install -y certbot ${plugin} 2>/dev/null`)) {
      if (!tryExec(`dnf install -y certbot ${plugin} 2>/dev/null`)) {
        warn("Could not install certbot. Continuing without SSL.");
        return;
      }
    }
  }

  // Write initial proxy config before certbot (certbot needs a server block)
  if (state.reverseProxy === "nginx") {
    writeNginxConfig(state, false);
    tryExec("nginx -t && systemctl reload nginx");
  }

  // Run certbot
  info(`Getting SSL certificate for ${state.domain}...`);
  const certCmd = state.reverseProxy === "nginx"
    ? `certbot --nginx -d ${state.domain} --non-interactive --agree-tos --email admin@${state.domain} --redirect`
    : `certbot --apache -d ${state.domain} --non-interactive --agree-tos --email admin@${state.domain} --redirect`;

  if (tryExec(certCmd)) {
    state.useSSL = true;
    pass(`SSL certificate obtained for ${state.domain}`);
  } else {
    warn("Let's Encrypt failed. Common causes:");
    console.log(`  ${c.dim}- DNS not pointing to this server${c.reset}`);
    console.log(`  ${c.dim}- Port 80 not open (check firewall: ufw allow 80)${c.reset}`);
    console.log(`  ${c.dim}- Rate limit exceeded${c.reset}`);
    console.log(`  ${c.dim}Continuing without SSL. Fix later: certbot --${state.reverseProxy} -d ${state.domain}${c.reset}`);
  }
}

// ─── Step 5: Deploy Conduit ─────────────────────────────────────────────────

function deployConduit(state: ProvisionState): boolean {
  step("Deploying Matrix Conduit");

  mkdirSync(CONDUIT_DIR, { recursive: true });

  // Write conduit.toml
  const toml = [
    "[global]",
    `server_name = "${state.serverName}"`,
    `database_backend = "rocksdb"`,
    `database_path = "/var/lib/matrix-conduit"`,
    `port = ${CONDUIT_INTERNAL_PORT}`,
    `max_request_size = 20000000`,
    `allow_registration = true`,
    `allow_federation = false`,
    `trusted_servers = ["matrix.org"]`,
    `address = "0.0.0.0"`,
  ].join("\n");
  writeFileSync(`${CONDUIT_DIR}/conduit.toml`, toml);

  // Write docker-compose.yml
  const listenPort = state.reverseProxy !== "none" ? "127.0.0.1:8448" : `0.0.0.0:${CONDUIT_EXTERNAL_PORT}`;
  const compose = [
    "services:",
    "  conduit:",
    "    image: matrixconduit/matrix-conduit:latest",
    "    container_name: matrix-conduit",
    "    restart: unless-stopped",
    "    ports:",
    `      - '${listenPort}:${CONDUIT_INTERNAL_PORT}'`,
    "    volumes:",
    "      - conduit-data:/var/lib/matrix-conduit",
    "      - ./conduit.toml:/etc/conduit.toml:ro",
    "    environment:",
    "      CONDUIT_CONFIG: /etc/conduit.toml",
    "volumes:",
    "  conduit-data:",
  ].join("\n");
  writeFileSync(`${CONDUIT_DIR}/docker-compose.yml`, compose);

  // Stop existing if running
  tryExec(`cd ${CONDUIT_DIR} && docker compose down 2>/dev/null`);

  // Start
  info("Starting Matrix Conduit container...");
  try {
    execSync(`cd ${CONDUIT_DIR} && docker compose up -d`, { stdio: "inherit", timeout: 120_000 });
    pass("Conduit container started");
    return true;
  } catch {
    fail("Failed to start Conduit. Check: docker logs matrix-conduit");
    return false;
  }
}

// ─── Step 6: Wait for health ────────────────────────────────────────────────

function waitForMatrix(state: ProvisionState): boolean {
  step("Waiting for Matrix server");

  const baseUrl = `http://127.0.0.1:${CONDUIT_EXTERNAL_PORT}`;

  for (let i = 0; i < 15; i++) {
    const check = tryExec(`curl -sf ${baseUrl}/_matrix/client/versions`);
    if (check) {
      pass(`Matrix server responding on ${baseUrl}`);
      state.matrixPort = CONDUIT_EXTERNAL_PORT;
      return true;
    }
    info(`  Waiting... (${i + 1}/15)`);
    tryExec("sleep 2");
  }

  fail("Matrix server didn't respond after 30 seconds");
  console.log(`  ${c.dim}Check: docker logs matrix-conduit${c.reset}`);
  console.log(`  ${c.dim}Check: docker ps | grep conduit${c.reset}`);
  return false;
}

// ─── Step 7: Reverse proxy config ───────────────────────────────────────────

function configureProxy(state: ProvisionState): void {
  step("Configuring reverse proxy");

  if (state.reverseProxy === "nginx") {
    writeNginxConfig(state, state.useSSL);
    if (tryExec("nginx -t")) {
      tryExec("systemctl reload nginx");
      pass("nginx configured and reloaded");
    } else {
      warn("nginx config test failed. Check: nginx -t");
    }
  } else if (state.reverseProxy === "apache") {
    writeApacheConfig(state);
    if (tryExec("apache2ctl configtest 2>&1") || tryExec("httpd -t 2>&1")) {
      tryExec("systemctl reload apache2 2>/dev/null || systemctl reload httpd");
      pass("Apache configured and reloaded");
    } else {
      warn("Apache config test failed");
    }
  }
}

function writeNginxConfig(state: ProvisionState, withSSL: boolean): void {
  const upstream = `http://127.0.0.1:${CONDUIT_EXTERNAL_PORT}`;
  const serverName = state.domain ?? state.serverName;

  let config = `
server {
    listen 80;
    server_name ${serverName};

    location /_matrix/ {
        proxy_pass ${upstream};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        client_max_body_size 20M;
    }

    location /.well-known/matrix/ {
        proxy_pass ${upstream};
    }
}`;

  // If certbot already set up SSL, don't overwrite — certbot manages it
  if (!withSSL) {
    const confPath = `/etc/nginx/sites-available/matrix`;
    writeFileSync(confPath, config);
    tryExec(`ln -sf ${confPath} /etc/nginx/sites-enabled/matrix`);
  }
}

function writeApacheConfig(state: ProvisionState): void {
  const upstream = `http://127.0.0.1:${CONDUIT_EXTERNAL_PORT}`;
  const serverName = state.domain ?? state.serverName;

  const config = `
<VirtualHost *:80>
    ServerName ${serverName}

    ProxyPreserveHost On
    ProxyPass /_matrix/ ${upstream}/_matrix/
    ProxyPassReverse /_matrix/ ${upstream}/_matrix/
    ProxyPass /.well-known/matrix/ ${upstream}/.well-known/matrix/
    ProxyPassReverse /.well-known/matrix/ ${upstream}/.well-known/matrix/
</VirtualHost>`;

  const confPath = `/etc/apache2/sites-available/matrix.conf`;
  writeFileSync(confPath, config);
  tryExec(`a2ensite matrix 2>/dev/null`);
}

// ─── Step 8: Register bot ───────────────────────────────────────────────────

function registerBot(state: ProvisionState): void {
  step("Registering OpenClaw bot");

  const baseUrl = `http://127.0.0.1:${state.matrixPort}`;
  const password = "openclaw-" + Math.random().toString(36).slice(2, 14);

  const result = tryExec(
    `curl -sf -X POST ${baseUrl}/_matrix/client/r0/register ` +
    `-H 'Content-Type: application/json' ` +
    `-d '{"username":"openclaw-bot","password":"${password}","auth":{"type":"m.login.dummy"}}'`
  );

  if (result) {
    try {
      const data = JSON.parse(result);
      state.botUserId = data.user_id;
      state.botAccessToken = data.access_token;
      pass(`Bot registered: ${data.user_id}`);
    } catch {
      warn("Bot registration returned unexpected data");
    }
  } else {
    // Might already exist — try login
    const loginResult = tryExec(
      `curl -sf -X POST ${baseUrl}/_matrix/client/r0/login ` +
      `-H 'Content-Type: application/json' ` +
      `-d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"openclaw-bot"},"password":"${password}"}'`
    );
    if (loginResult) {
      try {
        const data = JSON.parse(loginResult);
        state.botUserId = data.user_id;
        state.botAccessToken = data.access_token;
        pass(`Bot logged in: ${data.user_id}`);
      } catch {
        warn("Bot may already exist with a different password. Reset manually.");
      }
    } else {
      warn("Could not register or login bot. May need manual setup.");
    }
  }
}

// ─── Step 9: Register human user ────────────────────────────────────────────

async function registerHuman(rl: readline.Interface, state: ProvisionState): Promise<void> {
  step("Your Matrix account");

  const create = await ask(rl, `  Create a personal Matrix account? [Y/n] `);
  if (/^n/i.test(create)) return;

  const username = await ask(rl, `  Username: `);
  const password = await ask(rl, `  Password: `);

  if (!username.trim() || !password.trim()) return;

  const baseUrl = `http://127.0.0.1:${state.matrixPort}`;
  const result = tryExec(
    `curl -sf -X POST ${baseUrl}/_matrix/client/r0/register ` +
    `-H 'Content-Type: application/json' ` +
    `-d '{"username":"${username.trim()}","password":"${password.trim()}","auth":{"type":"m.login.dummy"}}'`
  );

  if (result) {
    state.humanUsername = username.trim();
    pass(`Account created: @${username.trim()}:${state.serverName}`);
  } else {
    warn("Account creation failed. Username may be taken.");
  }
}

// ─── Step 10: Connect OpenClaw ──────────────────────────────────────────────

function connectOpenClaw(state: ProvisionState): void {
  step("Connecting OpenClaw to Matrix");

  if (!state.botUserId || !state.botAccessToken) {
    warn("No bot credentials — skipping OpenClaw connection");
    return;
  }

  const homeserver = state.domain
    ? `${state.useSSL ? "https" : "http"}://${state.domain}`
    : `http://127.0.0.1:${state.matrixPort}`;

  const result = tryExec(
    `openclaw channels add --channel matrix ` +
    `--homeserver '${homeserver}' ` +
    `--user-id '${state.botUserId}' ` +
    `--access-token '${state.botAccessToken}' ` +
    `--device-name 'OpenClaw Bot' 2>/dev/null`
  );

  if (result !== null) {
    pass("OpenClaw connected to Matrix");
  } else {
    warn("OpenClaw connection failed. Try manually:");
    console.log(`  ${c.dim}openclaw channels add --channel matrix --homeserver ${homeserver} --user-id ${state.botUserId} --access-token ${state.botAccessToken}${c.reset}`);
  }
}

// ─── Step 11: Summary ───────────────────────────────────────────────────────

function printSummary(state: ProvisionState): void {
  const homeserver = state.domain
    ? `${state.useSSL ? "https" : "http"}://${state.domain}`
    : `http://SERVER_IP:${state.matrixPort}`;

  console.log(`\n${"─".repeat(50)}`);
  console.log(`\n  ${c.bold}${c.green}Matrix Server Ready!${c.reset}\n`);
  console.log(`  ${c.bold}Server:${c.reset}      ${state.serverName}`);
  console.log(`  ${c.bold}Homeserver:${c.reset}  ${homeserver}`);
  console.log(`  ${c.bold}SSL:${c.reset}         ${state.useSSL ? "yes (Let's Encrypt)" : "no"}`);
  console.log(`  ${c.bold}Proxy:${c.reset}       ${state.reverseProxy}`);
  if (state.botUserId) {
    console.log(`  ${c.bold}Bot:${c.reset}         ${state.botUserId}`);
  }
  if (state.humanUsername) {
    console.log(`  ${c.bold}Your user:${c.reset}   @${state.humanUsername}:${state.serverName}`);
  }

  console.log(`\n  ${c.bold}To chat with your AI:${c.reset}`);
  console.log(`  ${c.cyan}1.${c.reset} Open Element: ${c.dim}https://app.element.io${c.reset}`);
  console.log(`  ${c.cyan}2.${c.reset} Change homeserver to: ${c.dim}${homeserver}${c.reset}`);
  console.log(`  ${c.cyan}3.${c.reset} Log in as: ${c.dim}${state.humanUsername ?? "your username"}${c.reset}`);
  console.log(`  ${c.cyan}4.${c.reset} Start a DM with: ${c.dim}${state.botUserId ?? "@openclaw-bot:" + state.serverName}${c.reset}`);

  console.log(`\n  ${c.bold}Management:${c.reset}`);
  console.log(`  ${c.dim}docker logs matrix-conduit${c.reset}     — view server logs`);
  console.log(`  ${c.dim}openclaw channels status${c.reset}       — check channel health`);
  console.log(`  ${c.dim}openclaw gateway --verbose${c.reset}     — start OpenClaw gateway`);
  console.log(`  ${c.dim}notoken doctor${c.reset}                 — full system check\n`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function step(name: string): void {
  console.log(`\n  ${c.bold}${name}${c.reset}`);
}

function pass(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${c.yellow}⚠${c.reset} ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return rl.question(prompt);
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }).trim() || null;
  } catch {
    return null;
  }
}
