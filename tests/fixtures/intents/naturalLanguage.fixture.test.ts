import { describe, it, expect } from "vitest";
import { parseByRules } from "../../../packages/core/src/nlp/ruleParser.js";
import { routeByConcepts } from "../../../packages/core/src/nlp/conceptRouter.js";

/**
 * Tests for natural language phrases used during development.
 * Each phrase should route to the correct intent via either
 * rule parser or concept router.
 */

function resolveIntent(phrase: string): string {
  const rule = parseByRules(phrase);
  if (rule && rule.confidence >= 0.7) return rule.intent;
  const concept = routeByConcepts(phrase);
  if (concept && concept.confidence >= 0.5) return concept.intent;
  return "unknown";
}

describe("natural language phrases — full pipeline", () => {
  // Server / system
  it('"what is the load on my server"', () => {
    expect(resolveIntent("what is the load on my server")).toBe("server.uptime");
  });

  it('"how long has the server been running"', () => {
    expect(resolveIntent("how long has the server been running")).toBe("server.uptime");
  });

  it('"check my crontabs"', () => {
    expect(resolveIntent("check my crontabs")).toBe("cron.list");
  });

  it('"what crontabs are running"', () => {
    expect(resolveIntent("what crontabs are running")).toBe("cron.list");
  });

  // Files and projects
  it('"what projects do i have here"', () => {
    expect(resolveIntent("what projects do i have here")).toBe("project.scan");
  });

  it('"where are my files"', () => {
    expect(resolveIntent("where are my files")).toBe("dir.list");
  });

  it('"whats in this folder"', () => {
    expect(resolveIntent("whats in this folder")).toBe("dir.list");
  });

  it('"where are my media files"', () => {
    expect(resolveIntent("where are my media files")).toBe("files.find_media");
  });

  it('"find my movies"', () => {
    expect(resolveIntent("find my movies")).toBe("files.find_media");
  });

  // Image generation
  it('"generate a picture of a cat"', () => {
    expect(resolveIntent("generate a picture of a cat")).toBe("ai.generate_image");
  });

  it('"draw me a sunset"', () => {
    expect(resolveIntent("draw me a sunset")).toBe("ai.generate_image");
  });

  it('"image status"', () => {
    expect(resolveIntent("image status")).toBe("ai.image_status");
  });

  // Complex phrases via concept router
  it('"is this happening offline or using cloud"', () => {
    expect(resolveIntent("is this happening offline or using cloud")).toBe("ai.image_status");
  });

  it('"can you check what crontabs I have running"', () => {
    expect(resolveIntent("can you check what crontabs I have running")).toBe("cron.list");
  });

  it('"how much ram does this machine have"', () => {
    const intent = resolveIntent("how much ram does this machine have");
    expect(["server.check_memory", "hardware.info"]).toContain(intent);
  });

  it('"what is eating up my disk space"', () => {
    expect(resolveIntent("what is eating up my disk space")).toBe("server.check_disk");
  });

  it('"show me what containers are running"', () => {
    const intent = resolveIntent("show me what containers are running");
    expect(intent).toContain("docker");
  });

  // Knowledge lookup
  it('"what is kubernetes"', () => {
    expect(resolveIntent("what is kubernetes")).toBe("knowledge.lookup");
  });

  it('"who is linus torvalds"', () => {
    expect(resolveIntent("who is linus torvalds")).toBe("knowledge.lookup");
  });

  // System info
  it('"system summary"', () => {
    expect(resolveIntent("system summary")).toBe("system.resource_summary");
  });

  it('"what is my ip"', () => {
    const intent = resolveIntent("what is my ip");
    expect(["network.ip", "knowledge.lookup"]).toContain(intent);
  });

  // Browser
  it('"open google.com"', () => {
    expect(resolveIntent("open google.com")).toBe("browser.open");
  });

  it('"browser status"', () => {
    expect(resolveIntent("browser status")).toBe("browser.status");
  });
});
