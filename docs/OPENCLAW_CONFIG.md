# OpenClaw Configuration Guide

Everything notoken knows about setting up, configuring, and managing OpenClaw.

## Overview

OpenClaw is a messaging gateway that connects LLMs (Claude, Codex, Ollama) to chat channels (Telegram, Discord, Matrix, WhatsApp, Terminal TUI). Notoken can install, configure, diagnose, and manage OpenClaw automatically.

## Installation

```bash
# Via notoken
notoken install openclaw

# Manual
npm install -g openclaw

# Requires Node.js 22+
# If you have nvm:
nvm install 22
nvm use 22
```

**Binary location:** `/usr/local/bin/openclaw` → symlinks to `/usr/local/lib/node_modules/openclaw/openclaw.mjs`

**Version:** `openclaw --version` (current: 2026.3.28)

## Node 22 Requirement

OpenClaw requires Node.js 22+. The system may have Node 18 as default.

**nvm sourcing doesn't survive nohup/subshells.** When starting the gateway from a script or notoken, use the Node 22 binary path directly:

```bash
# Find Node 22 path
ls ~/.nvm/versions/node/v22*/bin/node | tail -1
# e.g. /home/ino/.nvm/versions/node/v22.22.2/bin/node

# Start gateway with Node 22 directly (NOT via nvm use)
/home/ino/.nvm/versions/node/v22.22.2/bin/node \
  /usr/local/lib/node_modules/openclaw/openclaw.mjs \
  gateway --force --allow-unconfigured
```

## Config Files

| File | Purpose |
|------|---------|
| `~/.openclaw/openclaw.json` | Main config (model, channels, gateway settings) |
| `~/.openclaw/agents/main/agent/auth-profiles.json` | Auth tokens (Claude OAuth, Codex OAuth, Ollama) |
| `~/.openclaw/openclaw.json.bak` | Auto-backup before config changes |
| `/tmp/openclaw/openclaw-YYYY-MM-DD.log` | Daily gateway log |

### Config Structure (`openclaw.json`)

```json
{
  "meta": { "lastTouchedVersion": "2026.3.28" },
  "auth": {
    "profiles": {
      "ollama:manual": { "provider": "ollama", "mode": "token" }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "anthropic/claude-opus-4-6" },
      "models": {
        "anthropic/claude-opus-4-6": {},
        "ollama/llama3.2": {},
        "openai-codex/gpt-5.4": {}
      }
    }
  },
  "models": {
    "providers": {
      "ollama": {
        "baseUrl": "http://127.0.0.1:11434",
        "api": "ollama",
        "apiKey": "OLLAMA_API_KEY",
        "models": [
          {"id": "llama3.2", "name": "llama3.2", "contextWindow": 131072},
          {"id": "llama2:13b", "name": "llama2:13b", "contextWindow": 4096}
        ]
      }
    }
  },
  "gateway": {
    "auth": { "mode": "token", "token": "<gateway-token>" }
  }
}
```

### Auth Profiles (`auth-profiles.json`)

```json
{
  "version": 1,
  "profiles": {
    "anthropic:claude-oauth": {
      "type": "oauth", "provider": "anthropic",
      "access": "sk-ant-oat01-...", "expires": 1775233740650
    },
    "openai-codex:default": {
      "type": "oauth", "provider": "openai-codex",
      "access": "eyJ...", "refresh": "rt_...", "expires": 1775935053000
    },
    "ollama:manual": {
      "type": "token", "provider": "ollama",
      "token": "ollama-local"
    }
  },
  "lastGood": {
    "anthropic": "anthropic:claude-oauth",
    "openai-codex": "openai-codex:default",
    "ollama": "ollama:manual"
  }
}
```

## CLI Commands

### Config (non-interactive)

```bash
openclaw config validate              # Validate config against schema
openclaw config get agents.defaults.model.primary  # Get a value
openclaw config set agents.defaults.model.primary '"ollama/llama3.2"' --strict-json
openclaw config set models.providers.ollama '{"baseUrl":"http://127.0.0.1:11434","api":"ollama","apiKey":"OLLAMA_API_KEY","models":[{"id":"llama3.2","name":"llama3.2","contextWindow":131072}]}' --strict-json
openclaw config file                  # Print config file path
openclaw config schema                # Print JSON schema
```

### Model Management

```bash
openclaw models status                # Show current model, auth, fallbacks
openclaw models status --plain        # Machine-readable
openclaw models set "ollama/llama3.2" # Switch default model
openclaw models list                  # List all configured models with status
openclaw models auth paste-token --provider ollama  # Register auth (interactive)
openclaw models auth login --provider anthropic     # OAuth login flow
```

### Gateway

```bash
openclaw gateway --force --allow-unconfigured  # Start (foreground)
openclaw gateway status               # Check gateway status
openclaw health                       # Health check with agent/session info
```

### Agent

```bash
openclaw agent --agent main --message "hello" --json  # Send message, get JSON response
openclaw tui                          # Terminal chat UI
```

### Channels

```bash
openclaw channels list                # List configured channels
openclaw configure --section channels # Interactive channel setup
```

## Model Providers

### Anthropic (Claude)

- Auth: OAuth via Claude CLI (`claude login` → `~/.claude/.credentials.json`)
- Notoken auto-syncs: reads Claude OAuth token and injects into OpenClaw
- Models: `anthropic/claude-opus-4-6`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-haiku-4-5`

### OpenAI / Codex

- Auth: OAuth via Codex CLI, or `OPENAI_API_KEY` env var
- Sync: `openclaw models auth setup-token --provider openai-codex --yes`
- Models: `openai-codex/gpt-5.4`, `openai-codex/gpt-4o`, `openai/gpt-4o`

### Ollama (Local)

- Auth: `OLLAMA_API_KEY="ollama-local"` (any value works — marker for local provider)
- **Critical:** Must register the provider config, not just auth. Use:
  ```bash
  openclaw config set models.providers.ollama '{"baseUrl":"http://127.0.0.1:11434","api":"ollama","apiKey":"OLLAMA_API_KEY","models":[{"id":"llama3.2","name":"llama3.2","contextWindow":131072}]}' --strict-json
  ```
- Auth profile registration (interactive):
  ```bash
  openclaw models auth paste-token --provider ollama
  # Paste: ollama-local
  ```
- Or via expect (non-interactive):
  ```bash
  expect -c '
  set timeout 10
  spawn openclaw models auth paste-token --provider ollama
  expect "Paste token"
  send "ollama-local\r"
  expect eof'
  ```
- **Minimum context window:** 16,000 tokens (OpenClaw hard requirement)
  - llama2:13b (4,096 ctx) — **TOO SMALL**, won't work
  - llama3.2 (131,072 ctx) — works, 2GB, recommended
  - phi3 (128,000 ctx) — works, 2.3GB
  - mistral (32,768 ctx) — works, 4.1GB
- Gateway must be started with `OLLAMA_API_KEY` env var:
  ```bash
  OLLAMA_API_KEY="ollama-local" openclaw gateway --force --allow-unconfigured
  ```
- Also add `lastGood` entry in auth-profiles.json:
  ```json
  "lastGood": { "ollama": "ollama:manual" }
  ```

## WSL / Windows Dual Environment

OpenClaw can run in WSL, on the Windows host, or both.

### Detection

```bash
# Check WSL
grep -qi microsoft /proc/version && echo "WSL" || echo "native"

# Check Windows host
cmd.exe /c 'where openclaw' 2>/dev/null          # Installed?
cmd.exe /c 'tasklist /FI "IMAGENAME eq node.exe" /V /NH' | grep openclaw  # Running?
```

### Current Setup

- **WSL:** OpenClaw at `/usr/local/bin/openclaw`, needs Node 22 via nvm
- **Windows:** OpenClaw at `C:\Users\Dino\AppData\Roaming\npm\openclaw`
  - Config: `C:\Users\Dino\.openclaw\openclaw.json`
  - Model: `anthropic/claude-opus-4-5`
  - Running as gateway on port 18789

### Port Conflict

Both WSL and Windows OpenClaw bind to `127.0.0.1:18789`. They cannot run simultaneously on the same port. WSL can reach the Windows gateway (and vice versa) because WSL shares the network namespace with Windows.

### Notoken Environment Targeting

All `openclaw.*` commands in notoken support environment qualifiers:

```
restart openclaw              → targets current env (WSL by default)
restart openclaw on windows   → targets Windows host
restart openclaw on wsl       → targets WSL
restart openclaw on both      → targets both
the other one                 → flips to opposite env from last command
not this one                  → same as "the other one"
```

## Notoken Intents

| Intent | What it does |
|--------|-------------|
| `openclaw.status` | Quick connectivity check (process → health → CLI → agent message) |
| `openclaw.diagnose` | 8-step diagnostic with auto-fix |
| `openclaw.doctor` | Auto-fix issues |
| `openclaw.message` | Send message to agent, get response |
| `openclaw.model` | Check or switch LLM (validates Ollama context window) |
| `openclaw.start` | Start gateway (finds Node 22, sets OLLAMA_API_KEY if needed) |
| `openclaw.stop` | Stop gateway (pkill, or taskkill on Windows) |
| `openclaw.restart` | Stop + start |

## Troubleshooting

### "Node.js v22.12+ is required"
OpenClaw CLI outputs this warning when invoked with Node 18. The actual command may still work if nvm was sourced. For reliable execution, use the Node 22 binary path directly.

### "Unknown model: ollama/llama3.2"
The Ollama provider isn't registered in the config. Fix:
```bash
OLLAMA_API_KEY="ollama-local" openclaw config set models.providers.ollama \
  '{"baseUrl":"http://127.0.0.1:11434","api":"ollama","apiKey":"OLLAMA_API_KEY","models":[{"id":"llama3.2","name":"llama3.2","contextWindow":131072}]}' \
  --strict-json
```

### "Model context window too small (4096 tokens). Minimum is 16000"
The model's context window is below OpenClaw's 16K minimum. Switch to llama3.2 (131K) or another model with ≥16K context.

### Gateway won't start
1. Check if another gateway is already on port 18789 (Windows host?)
2. Check disk space — C: drive full causes WSL crashes
3. Use `--force` flag to kill existing listeners
4. Use `--allow-unconfigured` if gateway.mode isn't set

### Config validation error
```bash
openclaw config validate  # Check what's wrong
openclaw doctor --fix     # Auto-fix
```

### Auth token expired
Claude OAuth tokens expire (~24h). Notoken auto-syncs from `~/.claude/.credentials.json` during diagnostics. Run `claude login` to refresh, then `is openclaw running` to re-sync.

## Environment Variables

| Var | Purpose |
|-----|---------|
| `OLLAMA_API_KEY` | Must be set when using Ollama models (any value, e.g. "ollama-local") |
| `OLLAMA_HOST` | Ollama API URL (default: http://127.0.0.1:11434) |
| `OPENCLAW_LOAD_SHELL_ENV` | Set to "1" to load env vars from login shell |
| `ANTHROPIC_API_KEY` | Direct API key auth for Claude (alternative to OAuth) |
| `OPENAI_API_KEY` | Direct API key for OpenAI models |

## Ollama Model Storage

Models moved from C: to D: drive to save space:
- **Location:** `/mnt/d/ollama/models`
- **Systemd config:** `Environment="OLLAMA_MODELS=/mnt/d/ollama/models"` in `/etc/systemd/system/ollama.service`
- **Models:** llama3.2 (2GB, 131K ctx), llama2:13b (7GB, 4K ctx)
