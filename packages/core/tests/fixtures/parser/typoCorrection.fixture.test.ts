import { describe, it, expect } from "vitest";
import { fuzzyMatch } from "../../../src/nlp/semantic.js";
import typos from "../../data/fixtures/phrases/typo-phrases.json";

const SERVICES = ["nginx", "redis", "api", "worker", "postgres"];
const ENVS = ["dev", "staging", "prod", "local"];
const ACTIONS = ["restart", "deploy", "rollback", "tail", "grep", "copy", "move"];
const ALL_CANDIDATES = [...SERVICES, ...ENVS, ...ACTIONS];

describe("typo correction fixtures", () => {
  for (const entry of typos) {
    it(`corrects "${entry.word}" → "${entry.expected}"`, () => {
      const result = fuzzyMatch(entry.word, ALL_CANDIDATES, entry.maxDistance);
      expect(result).not.toBeNull();
      expect(result!.match).toBe(entry.expected);
    });
  }
});
