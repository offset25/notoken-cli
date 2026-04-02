import { describe, it, expect } from "vitest";
import { detectBrowserEngines, getBestEngine } from "../../../packages/core/src/utils/browser.js";

describe("browser engine detection integration", () => {
  it("detects available engines on this system", () => {
    const engines = detectBrowserEngines();
    expect(engines.length).toBeGreaterThanOrEqual(1);

    // System browser should always be available
    const system = engines.find(e => e.engine === "system");
    expect(system).toBeDefined();
    expect(system!.available).toBe(true);
  });

  it("returns all 4 engine types", () => {
    const engines = detectBrowserEngines();
    const names = engines.map(e => e.engine);
    expect(names).toContain("patchright");
    expect(names).toContain("playwright");
    expect(names).toContain("docker");
    expect(names).toContain("system");
  });

  it("each engine has required fields", () => {
    const engines = detectBrowserEngines();
    for (const engine of engines) {
      expect(engine).toHaveProperty("engine");
      expect(engine).toHaveProperty("available");
      expect(typeof engine.available).toBe("boolean");
    }
  });

  it("getBestEngine returns a valid engine or null", () => {
    const best = getBestEngine();
    // Should at least return system browser
    expect(best).not.toBeNull();
    expect(["patchright", "playwright", "docker", "system"]).toContain(best!.engine);
    expect(best!.available).toBe(true);
  });

  it("prefers automation engines over system browser", () => {
    const engines = detectBrowserEngines();
    const best = getBestEngine();
    const hasAutomation = engines.some(
      e => e.available && e.engine !== "system" && e.browsersInstalled !== false
    );
    if (hasAutomation) {
      // Should pick automation engine, not system
      expect(best!.engine).not.toBe("system");
    } else {
      // Falls back to system
      expect(best!.engine).toBe("system");
    }
  });
});
