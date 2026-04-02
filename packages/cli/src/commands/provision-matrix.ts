/**
 * Matrix server provisioner.
 *
 * Cross-platform: Linux, macOS, Windows (native + WSL).
 *
 * Full self-hosted Matrix setup:
 * 1. Detect platform and adapt commands
 * 2. Check/install Docker (Desktop on Win/Mac, engine on Linux)
 * 3. Ask: custom domain or server IP/reverse DNS
 * 4. Check/install reverse proxy (nginx on Linux, skip on Win/Mac local)
 * 5. If domain on Linux → Let's Encrypt SSL
 * 6. Deploy Matrix Conduit via Docker Compose
 * 7. Wait for server health
 * 8. Register openclaw-bot + human user
 * 9. Connect OpenClaw to Matrix
 * 10. Verify end-to-end
 *
 * Every step has error handling. Failures suggest fixes.
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { platform as osPlatform, homedir } from "node:os";
import { resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};

type Platform = "linux" | "macos" | "windows" | "wsl";

function detectPlatform(): Platform {
  const p = osPlatform();
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  // Check WSL
  const release = tryExec("uname -r") ?? "";
  if (release.toLowerCase().includes("microsoft")) return "wsl";
  return "linux";
}

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

function getConduitDir(): string {
  const p = detectPlatform();
  if (p === "windows") return resolve(homedir(), ".notoken", "matrix-conduit");
  if (p === "macos") return resolve(homedir(), ".notoken", "matrix-conduit");
  return "/opt/matrix-conduit";
}

export async function provisionMatrix(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const plat = detectPlatform();
  const conduitDir = getConduitDir();
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
  const plat = detectPlatform();
  step("Checking Docker");

  if (tryExec("docker --version")) {
    pass("Docker installed");

    if (!tryExec("docker info --format '{{.ServerVersion}}'")) {
      warn("Docker daemon not running");

      if (plat === "windows") {
        fail("Start Docker Desktop from the Start menu, then try again.");
        return false;
      } else if (plat === "macos") {
        info("Trying to start Docker Desktop...");
        tryExec("open -a Docker");
        // Wait a bit for Docker Desktop to start
        for (let i = 0; i < 10; i++) {
          if (tryExec("docker info --format '{{.ServerVersion}}'")) break;
          tryExec("sleep 3");
        }
        if (tryExec("docker info --format '{{.ServerVersion}}'")) {
          pass("Docker Desktop started");
        } else {
          fail("Docker Desktop didn't start. Open it manually and try again.");
          return false;
        }
      } else if (plat === "wsl") {
        // In WSL, Docker Desktop should be running on Windows side
        fail("Docker not responding. Make sure Docker Desktop is running on Windows.");
        info("Enable WSL integration in Docker Desktop → Settings → Resources → WSL Integration");
        return false;
      } else {
        const start = await ask(rl, `  Start Docker? [Y/n] `);
        if (/^n/i.test(start)) { fail("Docker daemon required"); return false; }
        if (!tryExec("sudo systemctl start docker")) {
          fail("Could not start Docker. Try: sudo systemctl start docker");
          return false;
        }
        pass("Docker daemon started");
      }
    } else {
      pass("Docker daemon running");
    }
    return true;
  }

  warn("Docker not installed");
  const install = await ask(rl, `  Install Docker? [Y/n] `);
  if (/^n/i.test(install)) { fail("Docker required for Matrix server"); return false; }

  if (plat === "windows") {
    info("Installing Docker Desktop...");
    if (tryExec("winget install Docker.DockerDesktop")) {
      pass("Docker Desktop installed. Start it from the Start menu, then run this again.");
    } else {
      fail("Download Docker Desktop from https://docker.com/products/docker-desktop");
    }
    return false;
  } else if (plat === "macos") {
    info("Installing Docker Desktop via Homebrew...");
    if (tryExec("brew install --cask docker")) {
      info("Starting Docker Desktop...");
      tryExec("open -a Docker");
      for (let i = 0; i < 15; i++) {
        if (tryExec("docker info --format '{{.ServerVersion}}'")) { pass("Docker ready"); return true; }
        tryExec("sleep 3");
      }
      warn("Docker Desktop installed but may need manual start. Open it, then try again.");
      return false;
    } else {
      fail("Download Docker Desktop from https://docker.com/products/docker-desktop");
      return false;
    }
  } else if (plat === "wsl") {
    fail("Install Docker Desktop on Windows and enable WSL integration.");
    info("Download: https://docker.com/products/docker-desktop");
    info("Then: Docker Desktop → Settings → Resources → WSL Integration → Enable");
    return false;
  } else {
    info("Installing Docker Engine...");
    try {
      execSync("curl -fsSL https://get.docker.com | sh", { stdio: "inherit", timeout: 180_000 });
      execSync("sudo systemctl enable docker && sudo systemctl start docker", { stdio: "pipe", timeout: 30_000 });
      tryExec("sudo usermod -aG docker $USER");
      pass("Docker installed and running");
      return true;
    } catch {
      fail("Docker install failed. Try: curl -fsSL https://get.docker.com | sh");
      return false;
    }
  }
}

// ─── Step 2: Domain ─────────────────────────────────────────────────────────

async function configureDomain(rl: readline.Interface, state: ProvisionState): Promise<void> {
  const plat = detectPlatform();
  step("Server address");

  // On Windows/Mac/WSL local — just use localhost
  if (plat === "windows" || plat === "macos" || plat === "wsl") {
    state.serverName = "localhost";
    pass("Using localhost (local development mode)");
    info("For production, run this on a Linux server with a domain.");
    return;
  }

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
  const plat = detectPlatform();
  step("Reverse proxy");

  // On Windows/Mac local development, skip reverse proxy
  if ((plat === "windows" || plat === "macos") && !state.domain) {
    info("Local setup — accessing Matrix directly on port " + CONDUIT_EXTERNAL_PORT);
    info("For production with a domain, run this on a Linux server.");
    return;
  }

  // On WSL without a domain, also skip
  if (plat === "wsl" && !state.domain) {
    info("WSL local setup — accessing Matrix via localhost:" + CONDUIT_EXTERNAL_PORT);
    return;
  }

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

  if (plat === "macos") {
    console.log(`\n  ${c.cyan}1${c.reset} nginx via Homebrew ${c.dim}— recommended${c.reset}`);
    console.log(`  ${c.cyan}2${c.reset} Skip ${c.dim}— access directly on port ${CONDUIT_EXTERNAL_PORT}${c.reset}\n`);
    const choice = await ask(rl, `  Choice [1-2]: `);
    if (choice.trim() === "1") {
      if (tryExec("brew install nginx")) {
        tryExec("brew services start nginx");
        state.reverseProxy = "nginx";
        pass("nginx installed via Homebrew");
      } else {
        warn("nginx install failed. Install Homebrew first: https://brew.sh");
      }
    }
    return;
  }

  // Linux
  console.log(`  No web server found. Install one for SSL and domain hosting.\n`);
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
  const plat = detectPlatform();
  step("SSL certificate");

  if (!state.domain) return;

  // SSL via Let's Encrypt only works on Linux servers with public IPs
  if (plat === "windows" || plat === "macos") {
    info("Let's Encrypt requires a public server. For local dev, SSL is not needed.");
    info("Deploy to a Linux server for production SSL.");
    return;
  }

  if (plat === "wsl") {
    info("Let's Encrypt requires a public-facing server, not WSL.");
    info("Deploy to a Linux VPS for production SSL.");
    return;
  }

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
    configureNginx(state);
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
  const conduitDir = getConduitDir();
  step("Deploying Matrix Conduit");

  mkdirSync(conduitDir, { recursive: true });

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
  writeFileSync(`${conduitDir}/conduit.toml`, toml);

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
  writeFileSync(`${conduitDir}/docker-compose.yml`, compose);

  // Stop existing if running
  tryExec(`cd ${conduitDir} && docker compose down 2>/dev/null`);

  // Start
  info("Starting Matrix Conduit container...");
  try {
    execSync(`cd ${conduitDir} && docker compose up -d`, { stdio: "inherit", timeout: 120_000 });
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
    configureNginx(state);
  } else if (state.reverseProxy === "apache") {
    configureApache(state);
  }
}

function configureNginx(state: ProvisionState): void {
  const upstream = `http://127.0.0.1:${CONDUIT_EXTERNAL_PORT}`;
  const serverName = state.domain ?? state.serverName;
  const confName = "matrix";

  // Detect nginx config structure
  const hasSitesAvailable = existsSync("/etc/nginx/sites-available");
  const hasConfD = existsSync("/etc/nginx/conf.d");

  // Check for existing config that might conflict
  const existingConfigs = [
    `/etc/nginx/sites-available/${confName}`,
    `/etc/nginx/sites-enabled/${confName}`,
    `/etc/nginx/conf.d/${confName}.conf`,
  ];

  for (const path of existingConfigs) {
    if (existsSync(path)) {
      info(`Existing config found: ${path}`);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${path}.backup-${ts}`;
      tryExec(`cp "${path}" "${backup}"`);
      info(`Backed up to: ${backup}`);
    }
  }

  // Check if server_name already exists in another config
  const existingBlock = tryExec(`grep -rl "server_name.*${serverName}" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null`);
  if (existingBlock) {
    warn(`server_name ${serverName} already exists in: ${existingBlock.split("\n")[0]}`);
    info("Adding Matrix location blocks to existing config instead of creating new one.");

    // Inject location blocks into existing config
    const locationBlock = `
    # --- Matrix (added by notoken) ---
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
    # --- End Matrix ---`;

    const confFile = existingBlock.split("\n")[0].trim();
    // Check if Matrix locations already exist
    const hasMatrix = tryExec(`grep -l "_matrix" "${confFile}" 2>/dev/null`);
    if (hasMatrix) {
      info("Matrix location blocks already present. Skipping.");
    } else {
      // Insert before the last closing brace of the server block
      tryExec(`sed -i '/^}$/i ${locationBlock.replace(/\n/g, "\\n").replace(/\//g, "\\/")}' "${confFile}" 2>/dev/null`);
      if (!tryExec(`sed -i '/^}/i \\    # Matrix proxy\\n    location \\/_matrix\\/ {\\n        proxy_pass ${upstream.replace(/\//g, "\\/")};\\ \\n        proxy_set_header Host \\$host;\\n        proxy_buffering off;\\n        client_max_body_size 20M;\\n    }' "${confFile}" 2>/dev/null`)) {
        warn("Could not auto-inject into existing config.");
        info("Manually add these location blocks to your nginx config:");
        console.log(`${c.dim}${locationBlock}${c.reset}`);
      }
    }
  } else {
    // No conflict — create a new server block
    const config = `# Matrix Conduit reverse proxy — generated by notoken
# ${new Date().toISOString()}

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

    location /.well-known/matrix/server {
        default_type application/json;
        return 200 '{"m.server":"${serverName}:443"}';
    }

    location /.well-known/matrix/client {
        default_type application/json;
        add_header Access-Control-Allow-Origin *;
        return 200 '{"m.homeserver":{"base_url":"${state.useSSL ? "https" : "http"}://${serverName}"}}';
    }
}
`;

    if (hasSitesAvailable) {
      const confPath = `/etc/nginx/sites-available/${confName}`;
      writeFileSync(confPath, config);
      tryExec(`ln -sf ${confPath} /etc/nginx/sites-enabled/${confName}`);
      pass(`Config written to ${confPath}`);
    } else if (hasConfD) {
      const confPath = `/etc/nginx/conf.d/${confName}.conf`;
      writeFileSync(confPath, config);
      pass(`Config written to ${confPath}`);
    } else {
      warn("Could not find nginx config directory. Writing to /etc/nginx/matrix.conf");
      writeFileSync("/etc/nginx/matrix.conf", config);
      info("Add 'include /etc/nginx/matrix.conf;' to your nginx.conf http block.");
    }
  }

  // Test and reload
  const testResult = tryExec("nginx -t 2>&1");
  if (testResult && !testResult.includes("failed")) {
    tryExec("systemctl reload nginx 2>/dev/null || nginx -s reload");
    pass("nginx config valid and reloaded");
  } else {
    warn("nginx config test failed:");
    console.log(`  ${c.dim}${testResult}${c.reset}`);
    info("Fix the config and run: nginx -t && systemctl reload nginx");
  }
}

function configureApache(state: ProvisionState): void {
  const upstream = `http://127.0.0.1:${CONDUIT_EXTERNAL_PORT}`;
  const serverName = state.domain ?? state.serverName;

  // Check for existing vhost
  const existingVhost = tryExec(`grep -rl "ServerName.*${serverName}" /etc/apache2/sites-enabled/ /etc/httpd/conf.d/ 2>/dev/null`);

  if (existingVhost) {
    warn(`VirtualHost for ${serverName} already exists: ${existingVhost.split("\n")[0]}`);
    info("Add these lines inside your existing VirtualHost:");
    console.log(`${c.dim}    ProxyPreserveHost On`);
    console.log(`    ProxyPass /_matrix/ ${upstream}/_matrix/`);
    console.log(`    ProxyPassReverse /_matrix/ ${upstream}/_matrix/`);
    console.log(`    ProxyPass /.well-known/matrix/ ${upstream}/.well-known/matrix/`);
    console.log(`    ProxyPassReverse /.well-known/matrix/ ${upstream}/.well-known/matrix/${c.reset}`);
    return;
  }

  // Ensure proxy modules enabled
  tryExec("a2enmod proxy proxy_http proxy_wstunnel ssl rewrite headers 2>/dev/null");

  const config = `# Matrix Conduit reverse proxy — generated by notoken
# ${new Date().toISOString()}

<VirtualHost *:80>
    ServerName ${serverName}

    ProxyPreserveHost On
    ProxyPass /_matrix/ ${upstream}/_matrix/
    ProxyPassReverse /_matrix/ ${upstream}/_matrix/
    ProxyPass /.well-known/matrix/ ${upstream}/.well-known/matrix/
    ProxyPassReverse /.well-known/matrix/ ${upstream}/.well-known/matrix/
</VirtualHost>
`;

  // Detect Apache config structure
  const hasSitesAvailable = existsSync("/etc/apache2/sites-available");
  const hasConfD = existsSync("/etc/httpd/conf.d");

  if (hasSitesAvailable) {
    const confPath = "/etc/apache2/sites-available/matrix.conf";
    if (existsSync(confPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      tryExec(`cp "${confPath}" "${confPath}.backup-${ts}"`);
      info(`Backed up existing ${confPath}`);
    }
    writeFileSync(confPath, config);
    tryExec("a2ensite matrix 2>/dev/null");
    pass(`Config written to ${confPath}`);
  } else if (hasConfD) {
    const confPath = "/etc/httpd/conf.d/matrix.conf";
    if (existsSync(confPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      tryExec(`cp "${confPath}" "${confPath}.backup-${ts}"`);
    }
    writeFileSync(confPath, config);
    pass(`Config written to ${confPath}`);
  }

  // Test and reload
  const testResult = tryExec("apache2ctl configtest 2>&1") ?? tryExec("httpd -t 2>&1");
  if (testResult && (testResult.includes("Syntax OK") || testResult.includes("OK"))) {
    tryExec("systemctl reload apache2 2>/dev/null || systemctl reload httpd 2>/dev/null");
    pass("Apache config valid and reloaded");
  } else {
    warn("Apache config test issue:");
    console.log(`  ${c.dim}${testResult}${c.reset}`);
    info("Fix and reload: apache2ctl configtest && systemctl reload apache2");
  }
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
