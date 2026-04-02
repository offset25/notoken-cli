import { describe, it, expect } from "vitest";
import { parseByRules } from "../../../packages/core/src/nlp/ruleParser.js";

describe("image generation intent fixtures", () => {
  const generatePhrases = [
    "generate a picture of a cat",
    "create an image of a sunset",
    "draw a robot",
    "make me a picture of a dog",
    "paint a landscape",
    "generate art",
    "create a photo of mountains",
    "imagine a futuristic city",
  ];

  for (const phrase of generatePhrases) {
    it(`parses generate: "${phrase}"`, () => {
      const r = parseByRules(phrase);
      expect(r).not.toBeNull();
      expect(r!.intent).toBe("ai.generate_image");
    });
  }

  const statusPhrases = [
    "image status",
    "check image generator",
    "is stable diffusion running",
    "what are we using to generate",
    "how are images generated",
  ];

  for (const phrase of statusPhrases) {
    it(`parses status: "${phrase}"`, () => {
      const r = parseByRules(phrase);
      expect(r).not.toBeNull();
      expect(r!.intent).toBe("ai.image_status");
    });
  }

  const installPhrases = [
    "install stable diffusion",
    "install comfyui",
    "install fooocus",
    "setup image generation",
  ];

  for (const phrase of installPhrases) {
    it(`parses install: "${phrase}"`, () => {
      const r = parseByRules(phrase);
      expect(r).not.toBeNull();
      expect(r!.intent).toBe("ai.install_sd");
    });
  }
});
