# NoToken CLI Monorepo

## Structure
- `packages/core/` — notoken-core (shared engine, NLP, execution)
- `packages/core/tests/` — core tests (unit, fixture, integration, audit)
- `packages/cli/` — notoken (CLI tool)
- `packages/cli/tests/` — CLI tests (unit, e2e)

## Build & Test
```bash
npm run build                          # builds both workspaces
npm test                               # runs tests in ALL packages
npm run test:core                      # core tests only
npm run test:cli                       # CLI tests only
cd packages/core && npx vitest run     # core tests (direct)
cd packages/cli && npx vitest run      # CLI tests (direct)
```

## Multi-Agent Development
Multiple Claude agents may work on this project simultaneously. When making changes:
- **Always read files before editing** — another agent may have modified them
- **Check for merge conflicts** before committing
- **Build both packages** after any change
- **Run tests** from the monorepo root
- If a file was modified externally, re-read it before editing

## Git
- Committer: Dino Bartolome <dino.bartolome@gmail.com>
- Always include: `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- Never amend commits, always create new ones
- Don't push unless explicitly asked

## Key Files
- `packages/core/config/intents.json` — 213+ intent definitions
- `packages/core/src/nlp/` — NLP pipeline (ruleParser, conceptRouter, multiIntent, wikidata, vocabularyBuilder)
- `packages/core/src/handlers/executor.ts` — intent execution with custom handlers
- `packages/core/src/utils/imageGen.ts` — AI image generation (cloud + local SD)
- `packages/cli/src/commands/install.ts` — tool installer (cross-platform)

## Test Conventions
- **Core tests** (`packages/core/tests/`): 100 files — NLP, handlers, utils, parsers
  - `unit/` — pure logic, no network
  - `fixtures/` — intent parsing against saved phrase sets
  - `integration/` — multi-module pipelines
  - `audit/` — gold-standard accuracy checks
- **CLI tests** (`packages/cli/tests/`): 3 files — CLI-specific + E2E
  - `unit/` — CLI-specific logic
  - `e2e/` — spawn CLI binary, check stdout/exit codes
- All tests use vitest
- Import paths: tests import from `../../../src/` (relative to package root)
