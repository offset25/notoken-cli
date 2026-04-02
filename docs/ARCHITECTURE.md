# mycli Architecture

An NLP-based server operations CLI that translates natural language into executable commands.

## High-Level Flow

```
User Input
    │
    ▼
┌─────────────────┐
│  Greeting Check  │──→ "Hello! What would you like to work on?"
└────────┬────────┘
         │
    ▼
┌─────────────────┐
│ Secret Redaction │──→ passwords/tokens replaced with <password.UUID>
└────────┬────────┘
         │
    ▼
┌─────────────────┐
│   Coreference    │──→ "do it again" → last command
│   Resolution     │   "same but on prod" → override env
└────────┬────────┘
         │
    ▼
┌─────────────────┐     ┌──────────────┐
│  Multi-Step      │────→│  Goal Planner │──→ sequential execution
│  Detection       │     └──────────────┘
└────────┬────────┘
         │ (single step)
    ▼
┌─────────────────────────────────────────────┐
│              NLP Parse Pipeline              │
│                                             │
│  1. Rule Parser (synonym substring match)   │
│  2. LLM Parser (API fallback)              │
│  3. Disambiguator (missing fields, ambig)   │
│                                             │
│  Multi-Classifier Scoring:                  │
│    synonym (1.0x) + semantic (0.8x)        │
│    + context (0.6x) + fuzzy (0.5x)         │
└────────┬────────────────────────────────────┘
         │
    ▼
┌─────────────────┐
│  Uncertainty     │──→ logs unknown tokens, uncovered spans
│  Tracking        │
└────────┬────────┘
         │
    ▼
┌─────────────────┐     ┌──────────────────┐
│  Unknown Intent? │────→│ LLM Fallback     │──→ Claude CLI / API
│                  │     │ (background,     │   returns intent + plan
│                  │     │  non-blocking)   │
└────────┬────────┘     └──────────────────┘
         │ (known intent)
    ▼
┌─────────────────┐
│   Validation     │──→ required fields, allowlists, permissions
└────────┬────────┘
         │
    ▼
┌─────────────────┐
│  Confirmation    │──→ high-risk actions require [y/N]
└────────┬────────┘
         │
    ▼
┌─────────────────┐
│  Auto-Backup     │──→ backs up files before destructive ops
└────────┬────────┘
         │
    ▼
┌─────────────────────────────────────────────┐
│              Execution Layer                 │
│                                             │
│  ┌─────────┐  ┌─────────┐  ┌────────────┐ │
│  │  Local   │  │  SSH    │  │ simple-git │ │
│  │  Shell   │  │ Remote  │  │   (git.*)  │ │
│  └─────────┘  └─────────┘  └────────────┘ │
│                                             │
│  Smart routing: local when no real SSH host │
│  Spinner animation during execution         │
│  Auto-install suggestion on "cmd not found" │
└────────┬────────────────────────────────────┘
         │
    ▼
┌─────────────────┐
│  Output Analysis │──→ load/disk/memory assessment, dir analysis
└────────┬────────┘
         │
    ▼
┌─────────────────┐
│  Conversation    │──→ saved to ~/.notoken/conversations/
│  Store           │   knowledge tree, entity tracking
└─────────────────┘
```

## Directory Structure

```
mycli/
├── src/
│   ├── index.ts                 # Entry point — default interactive, or one-shot
│   ├── cli.ts                   # One-shot command execution
│   ├── interactive.ts           # Interactive REPL with all features
│   │
│   ├── nlp/                     # Natural Language Processing
│   │   ├── parseIntent.ts       # Orchestrator: rules → LLM → unknown
│   │   ├── ruleParser.ts        # Deterministic parser (reads intents.json synonyms)
│   │   ├── llmParser.ts         # LLM API fallback parser
│   │   ├── llmFallback.ts       # Claude CLI/API for unknown intents
│   │   ├── semantic.ts          # compromise NLP: POS tagging, dependency parse, concept graph
│   │   ├── multiClassifier.ts   # 4-classifier voting: synonym, semantic, context, fuzzy
│   │   ├── disambiguate.ts      # Missing fields, ambiguous candidates, confidence
│   │   ├── fuzzyResolver.ts     # Fuzzy file path resolution on remote servers
│   │   └── uncertainty.ts       # Tracks unknown tokens, uncovered phrases
│   │
│   ├── handlers/
│   │   └── executor.ts          # Generic command executor with smart routing
│   │
│   ├── execution/
│   │   ├── ssh.ts               # SSH remote + local shell execution
│   │   └── git.ts               # simple-git programmatic git operations
│   │
│   ├── agents/
│   │   ├── taskRunner.ts        # In-process async task queue (background execution)
│   │   ├── agentSpawner.ts      # Child process spawner for long-running agents
│   │   ├── planner.ts           # Multi-step goal planner ("X and then Y")
│   │   └── playbookRunner.ts    # Executes config-driven playbooks
│   │
│   ├── conversation/
│   │   ├── store.ts             # Conversation persistence (~/.notoken/conversations/)
│   │   ├── coreference.ts       # Pronoun/reference resolution ("it", "same but on prod")
│   │   └── secrets.ts           # Password detection, redaction, in-memory secret store
│   │
│   ├── healing/
│   │   ├── claudeHealer.ts      # Claude-powered self-healing (reads rules, proposes patches)
│   │   ├── runHealer.ts         # Standalone healer (LLM API)
│   │   ├── ruleBuilder.ts       # LLM generates rule patches from failure examples
│   │   ├── ruleRepairer.ts      # Reads failure log, feeds to builder
│   │   ├── ruleValidator.ts     # Validates patches (overlap, tests, safety)
│   │   └── patchPromoter.ts     # Applies patches to intents.json + rules.json with backup
│   │
│   ├── parsers/
│   │   ├── index.ts             # Auto-detect file type, dispatch to parser
│   │   ├── passwd.ts            # /etc/passwd parser
│   │   ├── shadow.ts            # /etc/shadow parser (metadata only, never stores hashes)
│   │   ├── envFile.ts           # .env parser + smart variable naming
│   │   ├── yamlParser.ts        # YAML with dot-path access
│   │   ├── jsonParser.ts        # JSON with key search
│   │   ├── nginxParser.ts       # nginx.conf → server blocks, locations, proxy_pass
│   │   ├── apacheParser.ts      # Apache config → VirtualHosts, directories
│   │   ├── bindParser.ts        # DNS zone files → SOA, A, MX, CNAME, TXT records
│   │   └── fileFinder.ts        # Smart file finder (reads config/file-hints.json)
│   │
│   ├── policy/
│   │   ├── safety.ts            # Validation, allowlists, risk levels (from intents.json)
│   │   └── confirm.ts           # Interactive confirmation + choice prompts
│   │
│   ├── intents/
│   │   └── catalog.ts           # Loads intent definitions from config
│   │
│   ├── context/
│   │   └── history.ts           # Command history + session context
│   │
│   ├── types/
│   │   ├── intent.ts            # Zod schemas: DynamicIntent, IntentDef, ParsedCommand
│   │   └── rules.ts             # Zod schemas: RulePatch, FailureLog, RulesConfig
│   │
│   └── utils/
│       ├── config.ts            # Loads rules.json, intents.json, hosts.json
│       ├── platform.ts          # OS/distro detection, package manager, init system
│       ├── permissions.ts       # File permissions: check, parse, chmod/chown logic
│       ├── analysis.ts          # Intelligent output analysis (load, disk, memory)
│       ├── dirAnalysis.ts       # Directory analysis: project detection, file types
│       ├── smartFile.ts         # Smart file reading: size check, sampling, search
│       ├── autoBackup.ts        # Auto-backup before destructive ops (~/.notoken/backups/)
│       ├── spinner.ts           # Terminal spinner + progress bar (ANSI, zero deps)
│       ├── verbose.ts           # Verbose restatement formatting
│       ├── output.ts            # Compact output formatting
│       └── logger.ts            # Failure log read/write
│
├── config/
│   ├── intents.json             # 119 intent definitions (synonyms, fields, commands, risk)
│   ├── rules.json               # Environment + service aliases (v2.0.1)
│   ├── hosts.json               # SSH targets per environment
│   ├── file-hints.json          # Known file locations by service (nginx, apache, etc.)
│   └── playbooks.json           # 9 reusable multi-step playbooks
│
├── tests/                       # 203 tests across 24 files
│   ├── unit/                    # Pure logic tests
│   ├── fixtures/                # Saved phrase → intent mapping tests
│   ├── integration/             # Multi-module pipeline tests
│   └── e2e/                     # Full CLI dry-run tests
│
├── docs/
│   └── ARCHITECTURE.md          # This file
├── TESTS.md                     # Test architecture guide
├── service.js                   # Build/run/test/heal helper
├── package.json
└── tsconfig.json
```

## Config-Driven Design

### intents.json — The Single Source of Truth

Every intent is defined as a JSON block. No TypeScript changes needed to add new commands.

```json
{
  "name": "service.restart",
  "description": "Restart a service in an environment",
  "synonyms": ["restart", "bounce", "reload", "recycle"],
  "fields": {
    "service": { "type": "service", "required": true },
    "environment": { "type": "environment", "required": true, "default": "dev" }
  },
  "command": "sudo systemctl restart {{service}} && sudo systemctl status {{service}} --no-pager",
  "execution": "remote",
  "requiresConfirmation": true,
  "riskLevel": "high",
  "allowlist": ["nginx", "redis", "api", "worker", "postgres"],
  "examples": ["restart nginx on prod", "bounce redis in production"]
}
```

**Parser matching**: The rule parser finds the **longest synonym substring** in the user's input. "restart" (7 chars) matches in "restart nginx on prod". If another intent had "restart nginx" (13 chars), that would win.

### rules.json — Entity Aliases

Maps user language to canonical entity names:

```json
{
  "environmentAliases": {
    "prod": ["prod", "production", "live", "prd"]
  },
  "serviceAliases": {
    "nginx": ["nginx", "web", "webserver", "proxy"]
  }
}
```

### hosts.json — SSH Targets

```json
{
  "prod": { "host": "deploy@prod.example.com", "description": "Production" }
}
```

When placeholder hosts are detected (e.g., `user@dev-server`), commands run locally automatically.

### file-hints.json — Known File Locations

```json
{
  "nginx": {
    "aliases": ["nginx", "web", "proxy"],
    "configs": [{ "path": "/etc/nginx/nginx.conf", "description": "Main config" }],
    "logs": [{ "path": "/var/log/nginx/error.log", "description": "Error log" }],
    "parser": "nginx"
  }
}
```

### playbooks.json — Multi-Step Recipes

```json
{
  "name": "health-check",
  "description": "Full server health check",
  "steps": [
    { "command": "uptime", "label": "Uptime & load" },
    { "command": "free -h", "label": "Memory usage" },
    { "command": "df -h", "label": "Disk usage" }
  ]
}
```

## NLP Pipeline

### Stage 1: Rule Parser (`ruleParser.ts`)

Deterministic, fast, no external deps. Reads synonyms from `intents.json`.

1. Match intent by longest synonym substring
2. Extract typed fields (environment, service, number, branch, string)
3. Handle preposition patterns ("X to Y", "X in Y", "X for Y")
4. Resolve aliases from `rules.json`
5. Calculate confidence based on field completeness

### Stage 2: compromise NLP (`semantic.ts`)

Uses the [compromise](https://github.com/spencermountain/compromise) library for:

- POS tagging (Verb, Noun, Adjective, Preposition from a real NLP model)
- Verb root extraction (conjugated forms → infinitive)
- Sentence analysis (tense, negation, question detection)

Domain overrides layered on top:
- Path tokens (`/var/log`) protected from compromise tokenization
- "to"/"from" forced to PREP (compromise misclassifies for CLI context)
- Domain verbs (`tail`, `grep`, `stash`) override when compromise tags as noun

### Stage 3: Multi-Classifier Scoring (`multiClassifier.ts`)

Four classifiers vote independently:

| Classifier | Weight | Method |
|-----------|--------|--------|
| **synonym** | 1.0 | Exact substring match from intents.json |
| **semantic** | 0.8 | compromise POS + dependency parse → action/entity scoring |
| **context** | 0.6 | Boosts intents from same domain as recent commands |
| **fuzzy** | 0.5 | QWERTY keyboard-distance matching for typos |

Scores are merged. Flags ambiguity when top two are close.

### Stage 4: LLM Fallback (`llmFallback.ts`)

Only fires when configured (`MYCLI_LLM_CLI=claude` or `MYCLI_LLM_ENDPOINT`).

- Sends full context: OS/distro, all 119 intents, recent history, entities
- Claude returns structured JSON: restatement, suggested intents, execution plan
- Non-blocking in interactive mode (notification on next prompt)
- Blocking in one-shot mode (executes top suggestion)

### Keyboard Distance (`semantic.ts`)

QWERTY-aware edit distance: adjacent key substitutions cost 0.5 instead of 1.

```
keyboardDistance("nginx", "ngimx") → 1.0  (i→m adjacent)
keyboardDistance("nginx", "ngizx") → 1.5  (i→z not adjacent)
```

## Execution Model

### Smart Routing

```
intent.execution === "local"  →  runLocalCommand()
environment === "local"       →  runLocalCommand()
no real SSH host configured   →  runLocalCommand()  (auto-detect placeholder)
git.* intents                 →  simple-git API
everything else               →  SSH to configured host
```

### Background Execution

```
mycli> restart nginx on prod &     ← TaskRunner (in-process async)
mycli> ssh prod "tail -f /var/log" &  ← AgentSpawner (child process)
mycli> :jobs                       ← show status
mycli> :output 1                   ← show result
mycli> :kill 1                     ← cancel
```

**TaskRunner**: Async function queue, max 5 concurrent, event-based notifications.
**AgentSpawner**: Forks child processes for long-running commands, captures stdout/stderr.

### Auto-Backup

Before `files.copy`, `files.move`, `files.remove`, `env.set`:

- **Local**: copies to `~/.notoken/backups/` with timestamp, 6-hour retention
- **Remote**: prepends `cp -a <file> /tmp/.notoken-backups/<file>.timestamp.bak`
- `:backups` to list, `:rollback <id>` to restore

### Missing Command Detection

When a command fails with "command not found":
1. Extracts the missing command name from the error
2. Maps to correct package name per distro (`dig` → `dnsutils` on Debian, `bind-utils` on RHEL)
3. Generates the install command for the detected package manager

## Conversation System

### Storage: `~/.notoken/conversations/<cwd-path>/`

Each conversation is a JSON file with:
- Turns (user + system, with intent, fields, result)
- Knowledge tree (entities with frequency, co-occurrences, recency)
- Uncertainty reports per turn

Sessions auto-resume within 1 hour, otherwise create new.

### Coreference Resolution

| Input | Resolution |
|-------|-----------|
| "do it again" | Repeat last command |
| "same but on staging" | Last command with environment overridden |
| "restart it" | "restart" + most recent service entity |
| "that service" | Most recently mentioned service |

### Secret Redaction

Detects passwords, API keys, tokens, SSH keys in input. Replaces with `<password.UUID>` in stored conversations. Secrets live in memory only — never written to disk unless `:save-secrets`.

## Self-Healing System

### Failure Loop

```
1. User says something parser can't match
2. Logged to logs/failures.json
3. Uncertainty logged to logs/uncertainty.json
4. Run: npm run heal:claude
5. Claude reads rules + failures + uncertainty
6. Proposes structured JSON patch (new synonyms, aliases)
7. Patch validated (overlap check, test cases)
8. Applied to intents.json with backup
9. Failure log cleared
```

### Patch Format

```json
{
  "summary": "Add synonyms for failed phrases",
  "confidence": 0.82,
  "changes": [
    { "type": "add_intent_synonym", "intent": "git.log", "phrase": "last 5 commits" },
    { "type": "add_service_alias", "canonical": "nginx", "alias": "webserver" }
  ],
  "tests": [
    { "input": "show last 5 commits", "expectedIntent": "git.log" },
    { "input": "random nonsense", "shouldReject": true }
  ],
  "warnings": ["'figure out why' is vague — could false-positive"]
}
```

## Intent Categories (119 total)

| Category | Count | Examples |
|----------|-------|---------|
| Service management | 6 | restart, status, start, stop, enable, disable |
| Server monitoring | 5 | disk, memory, uptime, history, info |
| Logs | 6 | tail, search, find, errors, check, journal, dmesg |
| Files | 10 | find, grep, list, tail, copy, move, remove, read, search_in, parse |
| Git | 11 | status, log, diff, pull, push, branch, checkout, commit, add, stash, reset |
| Docker | 15 | list, all, stop, start, restart, logs, images, cleanup, prune, compose (up/down/build/status/restart) |
| Network | 10 | ping, ports, curl, whois, dig, traceroute, ip, route, connections, scp, bandwidth |
| Deploy | 2 | run, rollback |
| Security | 4 | ufw, fail2ban, iptables, ssh keys |
| Certificates | 2 | check, generate |
| Database | 4 | pg_dump, pg_restore, mysql_dump, redis_cli |
| Users | 3 | add, modify, list |
| Permissions | 5 | check, chmod, chown, chmod_recursive, chown_recursive |
| Archives | 5 | tar, untar, zip, unzip, list |
| Sync | 2 | rsync, rsync_remote |
| Backup | 3 | create, restore, list |
| Packages | 2 | install, check |
| Swap | 3 | create, delete, status |
| System | 5 | hostname, datetime, reboot, shutdown, info |
| Cron | 3 | list, add, remove |
| Disk | 3 | mount, unmount, list |
| Environment | 2 | get, set |
| LLM | 3 | ask, claude_cli, convex |
| File search | 1 | where is / find config |

## Output Analysis

Automatic commentary appended to system check results:

**Load**: Detects vCPUs, calculates utilization ratio, flags overload, shows trend.
**Disk**: Flags partitions above 85%/95%, resolves path aliases ("c drive", "documents"), usage bars.
**Memory**: Usage bar, swap assessment, flags high pressure.
**Directory**: Detects 30+ project types (Node.js, Next.js, WordPress, Laravel, Go, Rust, etc.), file type breakdown, notable files.
**Smart File Read**: Size check, sample head+tail for large files, contextual search with highlighted matches.

## Dependencies

| Package | Purpose |
|---------|---------|
| `zod` | Schema validation for intents, rules, patches |
| `compromise` | NLP: POS tagging, verb extraction, sentence analysis |
| `simple-git` | Programmatic git operations |
| `yaml` | YAML file parsing |
| `dotenv` | .env file support |

Dev: `typescript`, `tsx`, `vitest`, `@types/node`

## Security Principles

1. **No raw shell from LLM output** — LLM returns structured intent JSON, handlers decide exact commands
2. **Allowlists** — per-intent service/container allowlists
3. **Confirmation gates** — high-risk actions require explicit [y/N]
4. **Secret redaction** — passwords never stored in conversation history
5. **Auto-backup** — files backed up before destructive operations
6. **Input sanitization** — field values checked against `[a-zA-Z0-9_./ :@-]` regex
7. **Patch validation** — self-healing patches checked for overlaps, tested before promotion
8. **Shadow parser** — never stores or exposes password hashes, only metadata
