import { describe, it, expect } from "vitest";
import { tokenize, parseDependencies } from "../../../src/nlp/semantic.js";

const SERVICES = ["nginx", "redis", "api", "worker", "postgres"];
const ENVS = ["dev", "staging", "prod", "local"];

describe("parseDependencies", () => {
  it("extracts verb-object for simple commands", () => {
    const tokens = tokenize("restart nginx on prod", SERVICES, ENVS);
    const deps = parseDependencies(tokens);

    const objectDep = deps.find((d) => d.relation === "object");
    expect(objectDep).toBeDefined();
    expect(objectDep!.dependent.text).toBe("nginx");
    expect(objectDep!.head.text).toBe("restart");
  });

  it("extracts location from preposition", () => {
    const tokens = tokenize("restart nginx on prod", SERVICES, ENVS);
    const deps = parseDependencies(tokens);

    const locDep = deps.find((d) => d.relation === "location");
    expect(locDep).toBeDefined();
    expect(locDep!.dependent.text).toBe("prod");
  });

  it("extracts destination from 'to'", () => {
    const tokens = tokenize("copy file to /root", SERVICES, ENVS);
    const deps = parseDependencies(tokens);

    const destDep = deps.find((d) => d.relation === "destination");
    expect(destDep).toBeDefined();
    expect(destDep!.dependent.text).toBe("/root");
  });

  it("extracts quantity from numbers", () => {
    const tokens = tokenize("tail 200 lines", SERVICES, ENVS);
    const deps = parseDependencies(tokens);

    const qtyDep = deps.find((d) => d.relation === "quantity");
    expect(qtyDep).toBeDefined();
    expect(qtyDep!.dependent.text).toBe("200");
  });

  it("returns empty deps when no verb", () => {
    const tokens = tokenize("nginx prod", SERVICES, ENVS);
    const deps = parseDependencies(tokens);
    expect(deps).toHaveLength(0);
  });
});
