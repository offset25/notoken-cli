import { describe, it, expect } from "vitest";
import { isNewer, formatUpdateBanner, type UpdateInfo } from "../../../src/utils/updater.js";

describe("isNewer", () => {
  it("detects major version bump", () => {
    expect(isNewer("2.0.0", "1.0.0")).toBe(true);
    expect(isNewer("3.0.0", "2.5.9")).toBe(true);
  });

  it("detects minor version bump", () => {
    expect(isNewer("1.2.0", "1.1.0")).toBe(true);
    expect(isNewer("1.7.0", "1.6.3")).toBe(true);
  });

  it("detects patch version bump", () => {
    expect(isNewer("1.0.1", "1.0.0")).toBe(true);
    expect(isNewer("1.6.5", "1.6.4")).toBe(true);
  });

  it("returns false for same version", () => {
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.7.0", "1.7.0")).toBe(false);
  });

  it("returns false when current is newer", () => {
    expect(isNewer("1.0.0", "2.0.0")).toBe(false);
    expect(isNewer("1.5.0", "1.7.0")).toBe(false);
    expect(isNewer("1.6.3", "1.6.5")).toBe(false);
  });

  it("handles missing patch component", () => {
    // Should treat missing as 0
    expect(isNewer("1.1.0", "1.0")).toBe(true);
    expect(isNewer("1.0", "1.0.0")).toBe(false);
  });

  it("handles 0.x versions", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  });

  it("handles large version numbers", () => {
    expect(isNewer("10.0.0", "9.99.99")).toBe(true);
    expect(isNewer("1.100.0", "1.99.0")).toBe(true);
  });

  it("does not false-positive on digit-by-digit comparison", () => {
    // Regression: old .some() approach would return true for 1.7.0 vs 1.7.0
    // because it checked digits individually
    expect(isNewer("1.7.0", "1.7.0")).toBe(false);
    // 9 is not > 10 even though '9' > '1' as string
    expect(isNewer("1.9.0", "1.10.0")).toBe(false);
  });
});

describe("formatUpdateBanner", () => {
  it("returns formatted banner when update is available", () => {
    const info: UpdateInfo = {
      current: "1.5.0",
      latest: "1.7.0",
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
    };
    const banner = formatUpdateBanner(info);
    expect(banner).toContain("1.5.0");
    expect(banner).toContain("1.7.0");
    expect(banner).toContain("Update available");
  });

  it("returns empty string when no update", () => {
    const info: UpdateInfo = {
      current: "1.7.0",
      latest: "1.7.0",
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    };
    expect(formatUpdateBanner(info)).toBe("");
  });
});
