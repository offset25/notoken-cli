# notoken

**A token-free terminal copilot that can install, repair, maintain, and operate your system — even when cloud LLMs are unavailable.**

I created this because when I run out of my Max Pro Plan, I have no way to give my system natural language commands without having to do the old-school typing-syntax-perfect-commands thing. When the fancy AI is unavailable, this still gets useful work done.

```
notoken> check disk space
✔ server.check_disk...
── Analysis ──
  ⚠ CRITICAL: /mnt/c is 99% full (6.1G free)
  ✓ Root filesystem healthy (4% used)

notoken> the server seems sluggish can you figure out why
LLM Interpretation:
  The user wants to diagnose why their server is running slowly
Plan:
  1. Check server uptime and load averages [server.uptime]
  2. Check memory usage [server.check_memory]
  3. Check disk usage [server.check_disk]
  4. List processes to find resource hogs [process.list]
```

## What Is This?

- **Offline terminal copilot** — works without any API keys or tokens
- **Deterministic CLI assistant** — rule-based, predictable, safe
- **Token-free command assistant** — no cloud calls needed for 119 built-in commands
- **Fallback system operator** — your safety net when Claude/GPT are down or over-limit
- **Maintenance copilot** — installs, repairs, diagnoses, monitors
- **Rule-based terminal helper** — understands natural language through pattern matching + NLP

## Two Modes

### Mode A: Deterministic Offline Mode (no LLM required)

Handles everything without any AI tokens:

- Installs & package management
- System diagnostics & health checks
- Service start/stop/restart/enable
- Log inspection & error detection
- File operations, archives, sync
- Git operations
- Docker & Docker Compose lifecycle
- Network tools (curl, dig, whois, traceroute)
- Security (firewall, fail2ban, SSH keys, certificates)
- Database dumps & restores
- Environment setup & repair
- Known repair flows (fix npm, fix PATH, fix permissions)
- 9 built-in playbooks (health-check, security-audit, virus-scan...)

### Mode B: Enhanced Mode with Optional LLM

If Claude CLI, OpenAI, or a local LLM is available, notoken uses it for:

- Ambiguous phrasing ("the server seems sluggish, figure out why")
- Multi-step troubleshooting plans
- Deeper diagnostics
- Self-healing (learns new synonyms from failures)
- Explaining what went wrong
- Complex multi-intent requests

**The tool is fully useful without an LLM, but better with one.**

## Who Is This For?

- **Developers** who run out of AI tokens but still need to manage servers
- **VPS owners** who want safe, guided sysadmin tasks
- **Homelab users** who want a smarter terminal
- **Field workers** with unstable internet who need offline terminal help
- **Anyone** who wants reproducible, safe terminal workflows

## Quick Start

```bash
npm install
npm run build

# Default: interactive mode
node service.js

# One-shot command
notoken "check disk on local" --yes

# With Claude CLI for enhanced mode
MYCLI_LLM_CLI=claude node service.js --auto-heal

# System health check
notoken doctor

# Install tools
notoken install claude
notoken install openclaw

# Fix broken things
notoken fix npm
notoken fix docker
```

## Subcommands

```bash
notoken                          # Interactive chat mode (default)
notoken doctor                   # Diagnose + auto-fix system issues
notoken install <tool>           # Install Claude, OpenClaw, Convex, Docker, Node...
notoken fix <target>             # Fix npm, git, docker, permissions, PATH, DNS
notoken setup <env>              # Set up dev/server/docker/node environment
notoken logs <service>           # Tail service logs
notoken heal:claude              # Claude-powered self-healing
notoken "any natural language"   # One-shot NLP command
```

## 119 Built-In Intents

| Category | Commands |
|----------|---------|
| **Services** | restart, status, start, stop, enable, disable |
| **System** | hostname, datetime, reboot, shutdown, info, history |
| **Monitoring** | disk, memory, uptime/load, processes |
| **Logs** | tail, search, find, errors, journal, dmesg |
| **Files** | find, grep, list, read, search-in, copy, move, remove, parse |
| **Git** | status, log, diff, pull, push, branch, checkout, commit, add, stash, reset |
| **Docker** | list, all, stop, start, restart, logs, images, cleanup, prune, compose (up/down/build/status/restart) |
| **Network** | ping, ports, curl, whois, dig, traceroute, ip, route, connections, scp, bandwidth |
| **Security** | ufw, fail2ban, iptables, SSH keys |
| **Certificates** | check SSL, generate self-signed |
| **Database** | pg_dump, pg_restore, mysqldump, redis-cli |
| **Archives** | tar, untar, zip, unzip, list contents |
| **Sync** | rsync (local + remote) |
| **Backups** | create, restore, list |
| **Packages** | install, check if installed |
| **Permissions** | check, chmod, chown (+ recursive) |
| **Swap** | create, delete, status |
| **Cron** | list, add, remove |
| **Disk** | mount, unmount, list devices |
| **Users** | add, modify, list |
| **Environment** | get/set .env variables with smart naming |
| **LLM** | ask Claude/ChatGPT, Claude CLI, Convex CLI |

## Intelligent Analysis

When you run system checks, notoken doesn't just show raw output — it interprets it:

```
notoken> check load on local
── Analysis ──
  vCPUs: 12
  Load:  0.71 (1m)  1.02 (5m)  1.19 (15m)
  ✓ OK: 6% CPU utilization. Healthy.
  → Load is stable.

notoken> show memory on local
── Analysis ──
  RAM: 16Gi used of 31Gi (48% available)
  ██████████░░░░░░░░░░
  ✓ Memory healthy.
  Swap: 960Mi/8.0Gi used. Some swapping is normal.
```

## Interactive Features

```
notoken> restart nginx on prod
notoken> do it again              # repeats last command
notoken> same but on staging      # changes environment
notoken> check disk on local &    # runs in background
notoken> :jobs                    # show background tasks
notoken> :play health-check prod  # run a playbook
notoken> :context                 # what entities the CLI remembers
notoken> :auto-heal               # learn from failures via Claude
```

**9 playbooks**: health-check, disk-analysis, load-analysis, security-audit, virus-scan, letsencrypt-setup, nginx-check, docker-check, backup-full.

## Smart File Handling

- Small files shown in full with line numbers
- Large files sampled (head + tail) with "search for more" tip
- Search within files shows matches with highlighted context lines
- Detects project types (Node.js, Next.js, WordPress, Laravel, Go, Rust, etc.)

## Safety Features

- **No raw shell from AI** — LLM returns structured intents, handlers decide commands
- **Allowlists** per intent for services and containers
- **Confirmation gates** for high-risk actions
- **Auto-backup** before destructive file operations
- **Secret redaction** — passwords never stored in conversation history
- **Input sanitization** on all interpolated values
- **Patch validation** before self-healing changes are applied

## Configuration

All config-driven. Add new commands by editing JSON — no TypeScript changes.

| File | Purpose |
|------|---------|
| `config/intents.json` | 119 intent definitions (synonyms, fields, commands, risk) |
| `config/rules.json` | Environment + service aliases |
| `config/hosts.json` | SSH targets per environment |
| `config/file-hints.json` | Known file locations by service |
| `config/playbooks.json` | Multi-step playbook recipes |

## Desktop App

There's also an Electron desktop app (`notoken-installer/`) with a chat-style interface — same CLI engine underneath, but with a friendly UI, plan cards, progress bars, and support links.

## Testing

```bash
npm test           # 203 tests across 24 files
npm run test:all   # unit + fixture + integration + e2e
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system design.

## Author

**Dino Bartolome**

Available for setup, automation, and development environment consulting.

## License

MIT
