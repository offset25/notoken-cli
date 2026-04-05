import { describe, it, expect } from "vitest";
import { validateIntent, isDangerous, getRiskLevel } from "../../../src/policy/safety.js";
import { buildIntent } from "../../helpers/builders/intentBuilder.js";

describe("validateIntent", () => {
  it("passes when all required fields present", () => {
    const intent = buildIntent({
      intent: "service.restart",
      fields: { service: "nginx", environment: "prod" },
    });
    const errors = validateIntent(intent);
    expect(errors).toHaveLength(0);
  });

  it("fails when required field missing", () => {
    const intent = buildIntent({
      intent: "service.restart",
      fields: { environment: "prod" },
    });
    const errors = validateIntent(intent);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("service");
  });

  it("fails when service not in allowlist", () => {
    const intent = buildIntent({
      intent: "service.restart",
      fields: { service: "malicious", environment: "prod" },
    });
    const errors = validateIntent(intent);
    expect(errors.some((e) => e.includes("allowlist"))).toBe(true);
  });
});

describe("isDangerous", () => {
  it("returns true for high-risk intents", () => {
    const intent = buildIntent({ intent: "service.restart" });
    expect(isDangerous(intent)).toBe(true);
  });

  it("returns false for low-risk intents", () => {
    const intent = buildIntent({
      intent: "server.check_disk",
      fields: { environment: "dev" },
    });
    expect(isDangerous(intent)).toBe(false);
  });
});

describe("getRiskLevel", () => {
  it("returns high for restart", () => {
    const intent = buildIntent({ intent: "service.restart" });
    expect(getRiskLevel(intent)).toBe("high");
  });

  it("returns low for check disk", () => {
    const intent = buildIntent({ intent: "server.check_disk", fields: {} });
    expect(getRiskLevel(intent)).toBe("low");
  });

  it("returns low for unknown intents", () => {
    const intent = buildIntent({ intent: "unknown", fields: {} });
    expect(getRiskLevel(intent)).toBe("low");
  });
});
