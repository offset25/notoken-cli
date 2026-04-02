import { describe, it, expect } from "vitest";
import { createPlan } from "../../../packages/core/src/agents/planner.js";

describe("createPlan", () => {
  it("returns single step for simple commands", () => {
    const plan = createPlan("restart nginx on prod");
    expect(plan.isMultiStep).toBe(false);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].intent).toBe("service.restart");
  });

  it("splits 'X and Y' into two steps", () => {
    const plan = createPlan("check disk on prod and show memory on prod");
    expect(plan.isMultiStep).toBe(true);
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("splits 'X then Y' into sequential steps", () => {
    const plan = createPlan("deploy main to staging then check disk on staging");
    expect(plan.isMultiStep).toBe(true);
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    // Second step should depend on first
    if (plan.steps.length >= 2) {
      expect(plan.steps[1].dependsOn).toContain(1);
    }
  });

  it("carries environment context between steps", () => {
    const plan = createPlan("restart nginx on prod and check disk on prod");
    expect(plan.isMultiStep).toBe(true);
    if (plan.steps.length >= 2) {
      expect(plan.steps[1].fields.environment).toBe("prod");
    }
  });

  it("handles comma-separated commands", () => {
    const plan = createPlan("check disk, show memory, list users on prod");
    expect(plan.isMultiStep).toBe(true);
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
  });
});
