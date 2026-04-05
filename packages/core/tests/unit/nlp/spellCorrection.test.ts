import { describe, it, expect } from "vitest";
import { parseByRules } from "../../../src/nlp/ruleParser.js";

describe("spell correction in rule parser", () => {
  it("corrects 'cheeck my crontabs' to cron.list", () => {
    const r = parseByRules("cheeck my crontabs");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("cron.list");
  });

  it("corrects 'genrate a picture' to ai.generate_image", () => {
    const r = parseByRules("genrate a picture of a cat");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("ai.generate_image");
  });

  it("corrects 'wher are my files' to dir.list", () => {
    const r = parseByRules("wher are my files");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("dir.list");
  });

  it("corrects 'systm summary' to system.resource_summary", () => {
    const r = parseByRules("systm summary");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("system.resource_summary");
  });

  it("corrects 'chek disk usage' to server.check_disk", () => {
    const r = parseByRules("chek disk usage");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("server.check_disk");
  });

  it("does not correct gibberish", () => {
    const r = parseByRules("xyzzy plonk quux wibble");
    expect(r).toBeNull();
  });

  it("still matches exact phrases without correction", () => {
    const r = parseByRules("restart nginx on prod");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("service.restart");
  });
});
