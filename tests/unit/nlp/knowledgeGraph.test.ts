import { describe, it, expect, beforeEach } from "vitest";
import {
  addEntity, getEntity, addRelation, getRelated,
  resolveReference, queryGraph,
  type KnowledgeGraph,
} from "../../../packages/core/src/nlp/knowledgeGraph.js";

// Reset the in-memory graph before each test by injecting a blank one
function resetGraph(): void {
  // Access the module-level _graph via loadKnowledgeGraph + direct mutation
  const g = (globalThis as any).__kg as KnowledgeGraph | undefined;
  // We rely on addEntity calling loadKnowledgeGraph which caches _graph.
  // Tests just layer on top of whatever was loaded.
}

describe("addEntity / getEntity", () => {
  it("retrieves entity by exact name", () => {
    addEntity("nginx", "service", ["web-server"], { port: 80 });
    const ent = getEntity("nginx");
    expect(ent).not.toBeNull();
    expect(ent!.name).toBe("nginx");
    expect(ent!.type).toBe("service");
  });

  it("retrieves entity by alias", () => {
    addEntity("my-pg-cluster", "database", ["pgcluster", "mypg"]);
    const ent = getEntity("pgcluster");
    expect(ent).not.toBeNull();
    expect(ent!.name).toBe("my-pg-cluster");
  });

  it("retrieves entity by case-insensitive name", () => {
    addEntity("Redis", "service");
    expect(getEntity("redis")).not.toBeNull();
    expect(getEntity("REDIS")).not.toBeNull();
  });

  it("retrieves entity by prefix (min 3 chars)", () => {
    addEntity("elasticsearch", "service");
    const ent = getEntity("ela");
    expect(ent).not.toBeNull();
    expect(ent!.name).toBe("elasticsearch");
  });

  it("deduplicates: adding same name twice overwrites", () => {
    addEntity("myapp", "service", [], { version: "1.0" });
    addEntity("myapp", "service", ["app"], { version: "2.0" });
    const ent = getEntity("myapp");
    expect(ent!.properties.version).toBe("2.0");
    expect(ent!.aliases).toEqual(["app"]);
  });

  it("returns null for unknown entity", () => {
    expect(getEntity("nonexistent_xyz_12345")).toBeNull();
  });
});

describe("addRelation / getRelated", () => {
  it("retrieves related entities", () => {
    addEntity("app-server", "server");
    addEntity("node-api", "service");
    addRelation("node-api", "app-server", "runs_on");
    const related = getRelated("app-server");
    expect(related.length).toBeGreaterThanOrEqual(1);
    const match = related.find(r => r.entity.name === "node-api");
    expect(match).toBeDefined();
    expect(match!.direction).toBe("incoming");
  });

  it("filters by relation type", () => {
    addEntity("svc-a", "service");
    addEntity("svc-b", "service");
    addRelation("svc-a", "svc-b", "depends_on");
    addRelation("svc-a", "svc-b", "connects_to");
    const deps = getRelated("svc-b", "depends_on");
    expect(deps.every(r => r.relation.relation === "depends_on")).toBe(true);
  });
});

describe("resolveReference", () => {
  it("resolves 'it' to most recent entity", () => {
    addEntity("caddy", "service");
    const ent = resolveReference("it", ["caddy"]);
    expect(ent).not.toBeNull();
    expect(ent!.name).toBe("caddy");
  });

  it("resolves 'the server' to recent server entity", () => {
    addEntity("prod-box", "server");
    const ent = resolveReference("the server", ["prod-box"]);
    expect(ent).not.toBeNull();
    expect(ent!.type).toBe("server");
  });

  it("resolves 'that service' to recent service entity", () => {
    addEntity("haproxy", "service");
    const ent = resolveReference("that service", ["haproxy"]);
    expect(ent).not.toBeNull();
    expect(ent!.type).toBe("service");
  });
});

describe("queryGraph", () => {
  it("filters by type", () => {
    addEntity("test-db", "database", [], { engine: "mysql" });
    const dbs = queryGraph({ type: "database" });
    expect(dbs.length).toBeGreaterThanOrEqual(1);
    expect(dbs.every(e => e.type === "database")).toBe(true);
  });
});
