import { describe, it, expect } from "vitest";
import { resolveEntity, verbalizeResolution, learnEntity, listEntities } from "../../../packages/core/src/utils/entityResolver.js";

describe("resolveEntity", () => {
  it("resolves exact server name", () => {
    const r = resolveEntity("metroplex");
    expect(r).not.toBeNull();
    expect(r!.name).toBe("metroplex");
    expect(r!.confidence).toBe("exact");
  });

  it("resolves alias 'the 66 server'", () => {
    const r = resolveEntity("the 66 server");
    expect(r).not.toBeNull();
    expect(r!.name).toBe("metroplex");
    expect(r!.confidence).toBe("alias");
  });

  it("resolves IP fragment '66'", () => {
    const r = resolveEntity("66");
    expect(r).not.toBeNull();
    expect(r!.name).toBe("metroplex");
    expect(r!.confidence).toBe("fuzzy");
  });

  it("resolves partial name 'metro'", () => {
    const r = resolveEntity("metro");
    expect(r).not.toBeNull();
    expect(r!.name).toBe("metroplex");
    expect(r!.confidence).toBe("fuzzy");
  });

  it("resolves database by name", () => {
    const r = resolveEntity("maindb");
    expect(r).not.toBeNull();
    expect(r!.type).toBe("database");
  });

  it("returns null for unknown entity", () => {
    const r = resolveEntity("totally_unknown_xyz");
    expect(r).toBeNull();
  });
});

describe("verbalizeResolution", () => {
  it("returns empty for exact match", () => {
    const r = resolveEntity("metroplex")!;
    expect(verbalizeResolution(r)).toBe("");
  });

  it("returns explanation for alias match", () => {
    const r = resolveEntity("the 66 server")!;
    const verb = verbalizeResolution(r);
    expect(verb).toContain("metroplex");
  });

  it("returns 'Assuming' for fuzzy match", () => {
    const r = resolveEntity("66")!;
    const verb = verbalizeResolution(r).replace(/\x1b\[[0-9;]*m/g, "");
    expect(verb).toContain("Assuming");
    expect(verb).toContain("metroplex");
  });
});

describe("learnEntity", () => {
  it("learns server from 'name is IP'", () => {
    const result = learnEntity("testbot is 10.20.30.40");
    expect(result).toContain("testbot");
    expect(result).toContain("10.20.30.40");
  });

  it("returns null for unparseable input", () => {
    const result = learnEntity("this is just random text");
    expect(result).toBeNull();
  });
});

describe("listEntities", () => {
  it("returns formatted entity list", () => {
    const result = listEntities().replace(/\x1b\[[0-9;]*m/g, "");
    expect(result).toContain("Defined Entities");
    expect(result).toContain("metroplex");
  });
});
