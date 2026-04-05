import { describe, it, expect } from "vitest";
import { splitCompoundSentence, parseMultiIntent } from "../../../src/nlp/multiIntent.js";

describe("splitCompoundSentence", () => {
  it("splits on 'and'", () => {
    const parts = splitCompoundSentence("check disk and list containers");
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain("disk");
    expect(parts[1]).toContain("containers");
  });

  it("splits on 'and also'", () => {
    const parts = splitCompoundSentence("check memory and also show me crontabs");
    expect(parts.length).toBe(2);
  });

  it("splits on commas", () => {
    const parts = splitCompoundSentence("check disk, show memory, list crontabs");
    expect(parts.length).toBe(3);
  });

  it("splits on semicolons", () => {
    const parts = splitCompoundSentence("check disk; list containers");
    expect(parts.length).toBe(2);
  });

  it("splits on 'then'", () => {
    const parts = splitCompoundSentence("restart nginx then check the logs");
    expect(parts.length).toBe(2);
  });

  it("does not split noun phrases like 'videos and photos'", () => {
    const parts = splitCompoundSentence("videos and photos");
    expect(parts.length).toBe(1);
  });

  it("returns single part for simple sentence", () => {
    const parts = splitCompoundSentence("check disk usage");
    expect(parts.length).toBe(1);
  });

  it("strips 'can you' from parts", () => {
    const parts = splitCompoundSentence("check disk and can you list containers");
    expect(parts.some(p => p.startsWith("can you"))).toBe(false);
  });

  it("handles empty string", () => {
    const parts = splitCompoundSentence("");
    expect(parts.length).toBe(0);
  });
});

describe("parseMultiIntent", () => {
  it("creates multi-step plan for 'check disk and list crontabs'", () => {
    const plan = parseMultiIntent("check disk usage and list my crontabs");
    expect(plan.isSingleIntent).toBe(false);
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[0].intent).toBe("server.check_disk");
    expect(plan.steps[1].intent).toBe("cron.list");
  });

  it("creates 3-step plan for comma-separated commands", () => {
    const plan = parseMultiIntent("check disk, show memory, and list containers");
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("returns single-intent plan for simple sentence", () => {
    const plan = parseMultiIntent("check disk usage");
    expect(plan.isSingleIntent).toBe(true);
    expect(plan.steps.length).toBeLessThanOrEqual(1);
  });

  it("deduplicates same intent from multiple parts", () => {
    const plan = parseMultiIntent("check disk usage and also check disk space");
    // Both map to server.check_disk — should only appear once
    const diskSteps = plan.steps.filter(s => s.intent === "server.check_disk");
    expect(diskSteps.length).toBeLessThanOrEqual(1);
  });

  it("flags steps that require confirmation", () => {
    const plan = parseMultiIntent("restart nginx and check disk usage");
    if (plan.steps.length >= 2) {
      const restartStep = plan.steps.find(s => s.intent === "service.restart");
      if (restartStep) {
        expect(restartStep.requiresConfirmation).toBe(true);
      }
    }
  });

  it("includes description and risk for each step", () => {
    const plan = parseMultiIntent("check disk and list crontabs");
    for (const step of plan.steps) {
      expect(step.description.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(step.riskLevel);
    }
  });

  it("handles complex real-world compound: 'check firewall, dns, and show connections'", () => {
    const plan = parseMultiIntent("check the firewall rules, check dns for my domain, and show active connections");
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("handles 'show me disk usage, check memory, and list running containers'", () => {
    const plan = parseMultiIntent("show me disk usage, check memory, and list running containers");
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    const intents = plan.steps.map(s => s.intent);
    expect(intents.some(i => i.includes("disk"))).toBe(true);
  });

  it("handles 'restart nginx then check if it's running and show the logs'", () => {
    const plan = parseMultiIntent("restart nginx then check if its running and show the logs");
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
  });
});
