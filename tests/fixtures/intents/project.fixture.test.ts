import { describe, it, expect } from "vitest";
import { parseByRules } from "../../../packages/core/src/nlp/ruleParser.js";

const phrases = [
  // project.detect
  { input: "what project is this", expectedIntent: "project.detect", minConfidence: 0.8 },
  { input: "show scripts", expectedIntent: "project.detect", minConfidence: 0.8 },
  { input: "whats in package.json", expectedIntent: "project.detect", minConfidence: 0.8 },
  { input: "available scripts", expectedIntent: "project.detect", minConfidence: 0.8 },
  // project.install
  { input: "npm install", expectedIntent: "project.install", minConfidence: 0.8 },
  { input: "install dependencies", expectedIntent: "project.install", minConfidence: 0.8 },
  { input: "composer install", expectedIntent: "project.install", minConfidence: 0.8 },
  { input: "pnpm install", expectedIntent: "project.install", minConfidence: 0.8 },
  // project.update
  { input: "npm update", expectedIntent: "project.update", minConfidence: 0.8 },
  { input: "update dependencies", expectedIntent: "project.update", minConfidence: 0.8 },
  { input: "composer update", expectedIntent: "project.update", minConfidence: 0.8 },
  // project.run
  { input: "run dev", expectedIntent: "project.run", minConfidence: 0.8 },
  { input: "run build", expectedIntent: "project.run", minConfidence: 0.8 },
  { input: "run test", expectedIntent: "project.run", minConfidence: 0.8 },
  { input: "start dev server", expectedIntent: "project.run", minConfidence: 0.8 },
  // archive.tar
  { input: "archive this folder", expectedIntent: "archive.tar", minConfidence: 0.8 },
  { input: "tar up this project", expectedIntent: "archive.tar", minConfidence: 0.8 },
  { input: "backup folder", expectedIntent: "archive.tar", minConfidence: 0.8 },
  { input: "pack up", expectedIntent: "archive.tar", minConfidence: 0.8 },
];

describe("project + archive intent fixtures", () => {
  for (const phrase of phrases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, () => {
      const result = parseByRules(phrase.input);
      expect(result).not.toBeNull();
      expect(result!.intent).toBe(phrase.expectedIntent);
      expect(result!.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});
