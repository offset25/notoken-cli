# NoToken CLI Monorepo

## Structure
- `packages/core/` — notoken-core (shared engine, NLP, execution)
- `packages/cli/` — notoken (CLI tool)
- `tests/` — all test files (unit, fixture, integration, e2e)

## Build
```bash
npm run build          # builds both workspaces
npx vitest run --root . # runs all tests from root
```

## Multi-Agent Development
Multiple Claude agents may be working on this project simultaneously. When making changes:
- **Always read files before editing** — another agent may have modified them
- **Check for merge conflicts** before committing
- **Build both packages** after any change: `cd packages/core && npm run build && cd ../cli && npm run build`
- **Run tests** from the monorepo root: `cd /usr/local/notoken/notoken-cli-mono && npx vitest run --root .`
- If a file was modified externally, re-read it before editing to avoid overwriting changes

## Git
- Committer: Dino Bartolome <dino.bartolome@gmail.com>
- Always include: `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- Never amend commits, always create new ones
- Don't push unless explicitly asked

## Key Files
- `packages/core/config/intents.json` — all 175+ intent definitions
- `packages/core/src/nlp/` — NLP pipeline (ruleParser, conceptRouter, multiIntent, wikidata, vocabularyBuilder)
- `packages/core/src/handlers/executor.ts` — intent execution with custom handlers
- `packages/core/src/utils/imageGen.ts` — AI image generation (cloud + local SD)
- `packages/cli/src/commands/install.ts` — tool installer (cross-platform)
