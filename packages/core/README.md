# notoken-core

Shared engine for [notoken](https://notoken.sh) — NLP parsing, execution, detection, analysis.

Used by the CLI (`notoken`) and the desktop app (`notoken-installer`).

## Install

```bash
npm install notoken-core
```

## Usage

```typescript
import {
  parseIntent,
  executeIntent,
  detectLocalPlatform,
  checkForUpdate,
} from "notoken-core";

// Parse natural language into a structured intent
const parsed = await parseIntent("restart nginx on prod");
console.log(parsed.intent.intent);  // "service.restart"
console.log(parsed.intent.fields);  // { service: "nginx", environment: "prod" }

// Detect platform
const platform = detectLocalPlatform();
console.log(platform.distro);       // "Ubuntu 24.04.2 LTS"
console.log(platform.packageManager); // "apt"
```

## What's Inside

- **119 config-driven intents** — services, docker, git, files, network, security, databases, and more
- **NLP pipeline** — rule parser + compromise POS tagging + multi-classifier + keyboard typo correction
- **LLM fallback** — Claude CLI, OpenAI API, or Ollama (auto-detected)
- **File parsers** — passwd, shadow, .env, yaml, json, nginx, apache, BIND zone files
- **Intelligent analysis** — load/disk/memory assessment, project type detection
- **Conversation persistence** — knowledge tree, coreference resolution
- **Platform detection** — Linux/macOS/Windows/WSL, adapts commands per OS
- **Adaptive rules** — learns from failures via LLM

## License

MIT — [Dino Bartolome](https://notoken.sh)
