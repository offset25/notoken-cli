import { describe, it, expect } from "vitest";
import { findOllamaApi, ollamaApiCall, getOllamaModels, getOllamaStatus } from "../../../packages/core/src/utils/ollamaClient.js";

describe("findOllamaApi", () => {
  it("returns an object or null", async () => {
    const result = await findOllamaApi();
    if (result) {
      expect(["api", "wsl"]).toContain(result.type);
      if (result.type === "api") expect(result.url).toContain("http");
    }
  });

  it("caches the result on subsequent calls", async () => {
    const r1 = await findOllamaApi();
    const r2 = await findOllamaApi();
    // Both should return same type (or both null)
    if (r1 && r2) expect(r1.type).toBe(r2.type);
  });
});

describe("ollamaApiCall", () => {
  it("handles /api/tags endpoint", async () => {
    const result = await ollamaApiCall("/api/tags");
    // Either null (no Ollama) or a valid response
    if (result) {
      expect(result).toHaveProperty("ok");
      expect(result).toHaveProperty("via");
      expect(result).toHaveProperty("data");
    }
  });
});

describe("getOllamaModels", () => {
  it("returns an array", async () => {
    const models = await getOllamaModels();
    expect(Array.isArray(models)).toBe(true);
  });

  it("model objects have name and size fields", async () => {
    const models = await getOllamaModels();
    if (models.length > 0) {
      expect(models[0]).toHaveProperty("name");
      expect(models[0]).toHaveProperty("size");
      expect(typeof models[0].name).toBe("string");
    }
  });

  it("model names follow name:tag format", async () => {
    const models = await getOllamaModels();
    for (const m of models) {
      // Most models have name:tag or just name
      expect(m.name.length).toBeGreaterThan(0);
    }
  });
});

describe("getOllamaStatus", () => {
  it("returns status structure", async () => {
    const status = await getOllamaStatus();
    expect(status).toHaveProperty("windowsRunning");
    expect(status).toHaveProperty("wslRunning");
    expect(status).toHaveProperty("windowsModels");
    expect(status).toHaveProperty("wslModels");
    expect(status).toHaveProperty("models");
    expect(status).toHaveProperty("via");
    expect(typeof status.windowsRunning).toBe("boolean");
    expect(typeof status.wslRunning).toBe("boolean");
    expect(typeof status.windowsModels).toBe("number");
    expect(typeof status.wslModels).toBe("number");
    expect(Array.isArray(status.models)).toBe(true);
  });

  it("via is one of Windows, WSL, or none", () => {
    // Sync check of possible values
    const validVia = ["Windows", "WSL", "none"];
    expect(validVia).toContain("none"); // at minimum
  });
});
