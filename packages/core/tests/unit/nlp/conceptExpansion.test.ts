import { describe, it, expect } from "vitest";
import {
  findCluster, expandQuery, suggestIntents, clusterWords,
} from "../../../src/nlp/conceptExpansion.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

describe("findCluster", () => {
  it("maps 'reboot' to 'restart' cluster", () => {
    expect(findCluster("reboot")).toBe("restart");
  });

  it("maps 'breach' to 'attack' cluster", () => {
    expect(findCluster("breach")).toBe("attack");
  });

  it("maps canonical name to itself", () => {
    expect(findCluster("restart")).toBe("restart");
    expect(findCluster("error")).toBe("error");
  });

  it("returns undefined for unknown word", () => {
    expect(findCluster("xylophone")).toBeUndefined();
    expect(findCluster("asdfghjkl")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(findCluster("REBOOT")).toBe("restart");
    expect(findCluster("Breach")).toBe("attack");
  });
});

describe("expandQuery", () => {
  it("appends synonyms for matched cluster", () => {
    const expanded = expandQuery("reboot the server");
    expect(expanded).toContain("reboot the server");
    expect(expanded).toContain("restart");
    expect(expanded).toContain("cycle");
  });

  it("does not modify text without cluster matches", () => {
    const text = "hello world foo bar";
    expect(expandQuery(text)).toBe(text);
  });

  it("does not duplicate words already in text", () => {
    const expanded = expandQuery("restart the server");
    // "restart" is already in text, should not be appended again
    const parts = expanded.split(/\s+/);
    const restartCount = parts.filter(w => w === "restart").length;
    expect(restartCount).toBe(1);
  });
});

describe("suggestIntents", () => {
  it("maps 'reboot' to service/docker domains", () => {
    const domains = suggestIntents("reboot");
    expect(domains.length).toBeGreaterThan(0);
    expect(domains).toContain("service.*");
  });

  it("returns empty for unknown word", () => {
    expect(suggestIntents("xylophone")).toEqual([]);
  });

  it("maps 'breach' to security domain", () => {
    const domains = suggestIntents("breach");
    expect(domains).toContain("security.*");
  });
});

describe("clusterWords", () => {
  it("returns full cluster including canonical name", () => {
    const words = clusterWords("restart");
    expect(words).toContain("restart");
    expect(words).toContain("reboot");
    expect(words).toContain("bounce");
    expect(words).toContain("cycle");
    expect(words).toContain("reload");
  });

  it("returns empty for nonexistent cluster", () => {
    expect(clusterWords("nonexistent_cluster")).toEqual([]);
  });
});

describe("concept-clusters.json coverage", () => {
  it("all 18 synonym clusters are loadable via findCluster", () => {
    const configPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../config/concept-clusters.json",
    );
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const clusterNames = Object.keys(config.synonymClusters);
    expect(clusterNames.length).toBe(18);
    for (const name of clusterNames) {
      expect(findCluster(name)).toBe(name);
    }
  });
});
