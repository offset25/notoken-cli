import { describe, it, expect } from "vitest";
import { parseByRules } from "../../../packages/core/src/nlp/ruleParser.js";

const phrases = [
  // ssh.test
  { input: "test ssh to prod", expectedIntent: "ssh.test", minConfidence: 0.8 },
  { input: "check ssh", expectedIntent: "ssh.test", minConfidence: 0.8 },
  { input: "test connection to staging", expectedIntent: "ssh.test", minConfidence: 0.8 },
  { input: "can i connect to dev", expectedIntent: "ssh.test", minConfidence: 0.8 },
  // ssh.connect
  { input: "ssh into prod", expectedIntent: "ssh.connect", minConfidence: 0.8 },
  { input: "connect to staging", expectedIntent: "ssh.connect", minConfidence: 0.8 },
  // docker.exec
  { input: "docker exec in container myapp", expectedIntent: "docker.exec", minConfidence: 0.8 },
  { input: "run in container nginx", expectedIntent: "docker.exec", minConfidence: 0.7 },
  { input: "shell into container redis", expectedIntent: "docker.exec", minConfidence: 0.7 },
];

describe("ssh + docker exec intent fixtures", () => {
  for (const phrase of phrases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, () => {
      const result = parseByRules(phrase.input);
      expect(result).not.toBeNull();
      expect(result!.intent).toBe(phrase.expectedIntent);
      expect(result!.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});
