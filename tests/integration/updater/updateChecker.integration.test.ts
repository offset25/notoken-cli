import { describe, it, expect } from "vitest";
import { checkForUpdate, checkForUpdateSync } from "../../../packages/core/src/utils/updater.js";

describe("update checker integration", () => {
  it("fetches latest version from network", async () => {
    const info = await checkForUpdate();
    // Should always return something (either from cache or network)
    expect(info).not.toBeNull();
    expect(info!.latest).toMatch(/^\d+\.\d+\.\d+$/);
    expect(info!.current).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof info!.updateAvailable).toBe("boolean");
    expect(info!.checkedAt).toBeDefined();
  });

  it("caches result for subsequent sync checks", async () => {
    // First: force a network check
    await checkForUpdate();

    // Second: sync check should return cached result
    const cached = checkForUpdateSync();
    expect(cached).not.toBeNull();
    expect(cached!.latest).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cached!.checkedAt).toBeDefined();
  });

  it("returns valid semver for latest", async () => {
    const info = await checkForUpdate();
    expect(info).not.toBeNull();
    const parts = info!.latest.split(".").map(Number);
    expect(parts).toHaveLength(3);
    expect(parts.every(n => Number.isInteger(n) && n >= 0)).toBe(true);
  });

  it("never throws — returns null on failure", async () => {
    // checkForUpdate is designed to never throw
    const result = await checkForUpdate();
    // Result should be either UpdateInfo or null, never an error
    if (result !== null) {
      expect(result).toHaveProperty("current");
      expect(result).toHaveProperty("latest");
      expect(result).toHaveProperty("updateAvailable");
    }
  });
});
