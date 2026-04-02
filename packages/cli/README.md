# notoken

**A token-free terminal copilot that installs, repairs, maintains, and operates your system — even when cloud LLMs are unavailable.**

When the fancy AI is unavailable, this still gets useful work done.

```
notoken> check disk space
✔ server.check_disk...
── Analysis ──
  ⚠ CRITICAL: /mnt/c is 99% full (6.1G free)
  ✓ Root filesystem healthy (4% used)

notoken> install claude
Installing Claude Code CLI...
✓ Claude Code CLI installed (2.1.90)

notoken> the server seems sluggish
Plan:
  1. Check server uptime and load averages
  2. Check memory usage
  3. Check disk space
  4. Find resource hogs
```

## Install

```bash
npm install -g notoken
notoken
```

## What It Does

Type server operations in plain English. **119 built-in intents** — no tokens needed.

| Category | Commands |
|----------|---------|
| Services | restart, start, stop, enable, disable |
| System | hostname, memory, disk, load, processes |
| Docker | containers, compose up/down/build, cleanup, prune |
| Git | status, log, diff, pull, push, branch, commit |
| Files | find, grep, list, read, copy, move, archives |
| Network | curl, dig, whois, ping, traceroute, ports |
| Security | ufw, fail2ban, iptables, SSH keys, SSL certs |
| Database | pg_dump, mysqldump, redis-cli |
| Packages | install, uninstall, check |

## Commands

```bash
notoken                          # Interactive mode (default)
notoken doctor                   # Diagnose + auto-fix system issues
notoken install <tool>           # Install claude, openclaw, ollama, docker...
notoken uninstall <tool>         # Clean removal
notoken setup openclaw           # Guided OpenClaw + Matrix setup
notoken setup dev                # Set up dev environment
notoken fix npm                  # Fix broken npm/git/docker/permissions
notoken check                    # Integration health check
notoken update                   # Check for updates and install
notoken logs <service>           # Tail service logs
notoken "any natural language"   # One-shot NLP command
```

## Two Modes

**Mode A — Offline (no LLM required)**
Handles installs, diagnostics, maintenance, service ops, log inspection, repair flows, and 9 built-in playbooks. Works without internet.

**Mode B — Enhanced (optional LLM)**
If Claude CLI, OpenAI, or Ollama is available, handles ambiguous phrasing, multi-step troubleshooting plans, and adaptive rules that improve over time.

```bash
# Enable adaptive rules
NOTOKEN_LLM_CLI=claude notoken --adapt

# Or use local Ollama (auto-detected, zero config)
ollama serve &
notoken
```

## Interactive Features

```
notoken> restart nginx on prod
notoken> do it again              # repeats last command
notoken> same but on staging      # changes environment
notoken> :adapt                   # toggle adaptive rules
notoken> :improve                 # run rule improvement now
notoken> :update                  # check for updates
notoken> :play health-check prod  # run a playbook
notoken> :context                 # what the CLI remembers
notoken> :explain                 # toggle explain mode
```

## Environment Variables

```bash
NOTOKEN_LLM_CLI=claude           # Claude CLI for LLM features
NOTOKEN_LLM_ENDPOINT=...         # API endpoint (Claude/OpenAI)
NOTOKEN_LLM_API_KEY=...          # API key
NOTOKEN_HOME=~/.notoken          # Data directory (default: ~/.notoken)
```

## Support & Consulting

Need help with setup, custom workflows, or team onboarding?

- **Environment setup** — full dev/server machine configuration
- **Custom automation** — tailored playbooks and intent packs for your stack
- **Team onboarding** — standardized environments and training
- **Troubleshooting** — broken environment recovery, performance investigation

**Contact:** [dino@notoken.sh](mailto:dino@notoken.sh) | [notoken.sh/consulting](https://notoken.sh/consulting)

## Links

- **Website:** [notoken.sh](https://notoken.sh)
- **GitHub:** [offset25/notoken-cli](https://github.com/offset25/notoken-cli)
- **Author:** Dino Bartolome

## License

MIT
