import { describe, it, expect } from "vitest";
import { loadPlaybooks, getPlaybook, formatPlaybookList } from "../../../packages/core/src/agents/playbookRunner.js";

describe("playbook system", () => {
  it("loads playbooks from config", () => {
    const playbooks = loadPlaybooks();
    expect(playbooks.length).toBeGreaterThan(0);
  });

  it("finds health-check playbook", () => {
    const pb = getPlaybook("health-check");
    expect(pb).toBeDefined();
    expect(pb!.steps.length).toBeGreaterThan(0);
  });

  it("finds virus-scan playbook", () => {
    const pb = getPlaybook("virus-scan");
    expect(pb).toBeDefined();
  });

  it("finds letsencrypt-setup playbook", () => {
    const pb = getPlaybook("letsencrypt");
    expect(pb).toBeDefined();
  });

  it("finds disk-analysis playbook", () => {
    const pb = getPlaybook("disk-analysis");
    expect(pb).toBeDefined();
  });

  it("returns undefined for unknown playbook", () => {
    const pb = getPlaybook("nonexistent-playbook-xyz");
    expect(pb).toBeUndefined();
  });

  it("formats playbook list", () => {
    const list = formatPlaybookList();
    expect(list).toContain("health-check");
    expect(list).toContain("virus-scan");
  });
});
