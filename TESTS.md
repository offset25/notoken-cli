# mycli Test Architecture

## Test Layers

| Layer | Purpose | Data Source | Speed | When to Run |
|-------|---------|-------------|-------|-------------|
| **Unit** | Pure logic correctness | Hardcoded / inline | Fast | Every commit |
| **Fixture** | Extraction correctness on saved inputs | Saved JSON/HTML | Fast | Every commit |
| **Integration** | Module cooperation | Mocked or dev API | Medium | Every commit |
| **E2E** | Full pipeline from input to output | Fixture or live | Medium-Slow | PR / nightly |
| **Live** | Source health, drift, smoke | Real production | Slow/flaky | Scheduled |
| **Audit** | Human-reviewed quality truth | Gold-standard data | Medium | Weekly / on demand |

## Classification Rules

- **Unit test**: no network, no filesystem beyond small helpers, deterministic inputs
- **Fixture test**: uses saved data (JSON/HTML) — the "data source", not the "test level"
- **Integration test**: crosses real system boundaries (API, DB), or wires multiple modules
- **E2E test**: full workflow from user input to final output
- **Live test**: hits real external systems, threshold-based assertions
- **Audit test**: compares against human-reviewed correct answers

A test can be both a level AND a data style:
- `unit + fixture` — sort function tested with saved JSON
- `integration + dev-real` — API call to dev server
- `e2e + fixture` — full pipeline on saved site bundle
- `e2e + live` — full pipeline on current live data

## Folder Structure

```
tests/
  unit/
    nlp/
      tokenizer.test.ts
      keyboardDistance.test.ts
      ruleParser.test.ts
      fuzzyMatch.test.ts
      dependencyParser.test.ts
    policy/
      safety.test.ts
      validation.test.ts
    context/
      history.test.ts
    handlers/
      executor.test.ts
      interpolation.test.ts

  fixtures/
    intents/
      restart.fixture.test.ts
      deploy.fixture.test.ts
      fileCopy.fixture.test.ts
      userOps.fixture.test.ts
    parser/
      ambiguousInputs.fixture.test.ts
      typoCorrection.fixture.test.ts

  integration/
    pipeline/
      parse-to-execute.integration.test.ts
      parse-to-disambiguate.integration.test.ts
    healing/
      ruleBuilder.integration.test.ts
      patchPromoter.integration.test.ts
    api/
      llmParser.integration.test.ts

  e2e/
    shared/
      full-pipeline.e2e.test.ts
      interactive-mode.e2e.test.ts
      self-healing-flow.e2e.test.ts
    dev-only/
      repair-and-promote.e2e.test.ts
    live-only/
      smoke.e2e.test.ts

  live/
    parser/
      drift-detection.live.test.ts
    source-health/
      ssh-targets.live.test.ts

  audit/
    goldsets/
      common-phrases.audit.test.ts

  helpers/
    assertions/
      assertValidParse.ts
      assertValidExecution.ts
    fixtures/
      loadFixture.ts
    builders/
      intentBuilder.ts

  data/
    fixtures/
      phrases/
        restart-phrases.json
        deploy-phrases.json
        file-ops-phrases.json
        typo-phrases.json
      expected/
        restart-expected.json
    goldsets/
      reviewed-phrases.json
```

## What Goes Where

### Unit Tests

Test pure functions in isolation:

- `keyboardDistance("nginx", "ngimx")` returns expected score
- `tokenize("restart nginx on prod", ...)` returns correct tags
- `parseDependencies(tokens)` extracts correct SVO structure
- `sanitize("safe-value")` passes, `sanitize("rm -rf /")` throws
- `interpolateCommand(def, fields)` produces correct shell string
- `validateIntent(intent)` catches missing required fields

### Fixture Tests

Test parser against saved phrase sets:

```json
// data/fixtures/phrases/restart-phrases.json
[
  { "input": "restart nginx on prod", "expectedIntent": "service.restart", "minConfidence": 0.8 },
  { "input": "bounce redis in production", "expectedIntent": "service.restart", "minConfidence": 0.8 },
  { "input": "recycle the api", "expectedIntent": "service.restart", "minConfidence": 0.6 }
]
```

These are deterministic — same input always produces same parse. High value for catching regressions.

### Integration Tests

Test subsystem boundaries:

- Rule parser → disambiguator → policy validator (full parse pipeline)
- RuleBuilder → RuleValidator → PatchPromoter (self-healing pipeline)
- LLM parser with mocked API response → zod validation

### E2E Tests

Test the full CLI from input to output:

- `npx tsx src/index.ts "restart nginx on prod" --dry-run` → exits 0, output contains intent
- Interactive mode: send commands, verify responses
- Self-healing: log failures → run healer → verify rules updated

### Live Tests

Threshold-based, not exact-match:

- "At least 90% of common phrases parse correctly"
- "SSH target for dev responds to ping"
- "Parser handles current team slang" (run against recent failure log)

### Audit Tests

Compare against human-reviewed gold set:

- 50 phrases manually labeled with correct intent + fields
- Parser must match at least 85% correctly
- Any regression from previous audit run is flagged

## Environment Handling

Tests are organized by **scenario** first, **environment** second.

```
# Run all unit + fixture (fast, CI)
npm test

# Run integration against dev
E2E_ENV=dev npm run test:integration

# Run e2e against dev
E2E_ENV=dev npm run test:e2e

# Run live checks (scheduled, not on every commit)
npm run test:live

# Run everything except live
npm run test:all
```

### When to use each environment

| Environment | Unit | Fixture | Integration | E2E | Live |
|-------------|------|---------|-------------|-----|------|
| none (isolated) | Yes | Yes | - | - | - |
| dev | - | - | Yes | Yes | - |
| staging | - | - | Optional | Optional | - |
| live/prod | - | - | - | Smoke only | Yes |

## Key Principles

1. **Unit test = "does my logic work?"**
2. **Fixture test = "does my logic work on realistic saved input?"**
3. **Integration test = "do these modules cooperate?"**
4. **E2E test = "does the whole pipeline work start to finish?"**
5. **Live test = "does it work in the real world right now?"**
6. **Audit test = "is the quality actually good?"**

If a test touches the internet → not a unit test.
If a test uses archived real data → probably a fixture test.
If a human reviewed the expected answer → probably an audit test.
If a test crosses a real system boundary → integration or above.
