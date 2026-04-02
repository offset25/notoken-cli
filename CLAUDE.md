# NoToken CLI Monorepo

## Structure
- `packages/core/` — notoken-core (shared engine, NLP, execution)
- `packages/cli/` — notoken (CLI tool)
- `tests/` — all test files (unit, fixture, integration, e2e)

## Build & Test
```bash
npm run build                          # builds both workspaces
cd packages/core && npm run build      # build core only
cd packages/cli && npm run build       # build CLI only
npx vitest run --root .                # run all tests from monorepo root
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
- **Unit tests** (`tests/unit/`): pure logic, no network
- **Fixture tests** (`tests/fixtures/`): test parser against saved phrase sets
- **Integration tests** (`tests/integration/`): multi-module pipelines
- **E2E tests** (`tests/e2e/`): spawn CLI, check stdout/exit codes
- All tests use vitest
