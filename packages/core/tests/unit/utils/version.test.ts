import { describe, it, expect } from "vitest";
import { getLocalVersion, compareSemver } from "../../../src/utils/version.js";

describe("getLocalVersion", () => {
  it("returns a valid semver string", () => {
    const version = getLocalVersion();
    expect(version).not.toBe("unknown");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  it("returns 1 when a > b (patch)", () => {
    expect(compareSemver("1.0.2", "1.0.1")).toBe(1);
  });

  it("returns -1 when a < b (patch)", () => {
    expect(compareSemver("1.0.1", "1.0.2")).toBe(-1);
  });

  it("returns 1 when a > b (minor)", () => {
    expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
  });

  it("returns 1 when a > b (major)", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
  });

  it("handles missing patch", () => {
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
  });
});
