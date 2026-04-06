/**
 * Knowledge Graph — persistent entity-relationship store.
 * Persists to ~/.notoken/knowledge-graph.json.
 * Auto-populates from entities.json, rules.json, and running system state.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEntities, type EntitiesConfig } from "../utils/entityResolver.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type EntityType =
  | "service" | "server" | "database" | "port"
  | "user" | "package" | "container" | "path" | "llm" | "channel";

export type RelationType =
  | "runs_on" | "depends_on" | "has_port" | "has_ip"
  | "installed_on" | "uses" | "owned_by" | "connects_to" | "requires";

export interface GraphEntity {
  name: string; type: EntityType; aliases: string[];
  properties: Record<string, string | number | boolean>;
}

export interface GraphRelation {
  from: string; to: string; relation: RelationType;
  properties?: Record<string, string | number | boolean>;
}

export interface KnowledgeGraph {
  entities: Record<string, GraphEntity>; relations: GraphRelation[]; lastBuilt?: string;
}

// ─── Persistence ────────────────────────────────────────────────────────────

const GRAPH_DIR = join(homedir(), ".notoken");
const GRAPH_PATH = join(GRAPH_DIR, "knowledge-graph.json");
let _graph: KnowledgeGraph | null = null;

export function loadKnowledgeGraph(): KnowledgeGraph {
  if (_graph) return _graph;
  if (existsSync(GRAPH_PATH)) {
    try { _graph = JSON.parse(readFileSync(GRAPH_PATH, "utf-8")); return _graph!; } catch { /* rebuild */ }
  }
  _graph = buildGraph();
  saveKnowledgeGraph(_graph);
  return _graph;
}

export function saveKnowledgeGraph(graph?: KnowledgeGraph): void {
  const g = graph ?? _graph;
  if (!g) return;
  if (!existsSync(GRAPH_DIR)) mkdirSync(GRAPH_DIR, { recursive: true });
  writeFileSync(GRAPH_PATH, JSON.stringify(g, null, 2) + "\n");
  _graph = g;
}

// ─── Mutation ───────────────────────────────────────────────────────────────

export function addEntity(name: string, type: EntityType, aliases: string[] = [], properties: Record<string, string | number | boolean> = {}): GraphEntity {
  const g = loadKnowledgeGraph();
  const entity: GraphEntity = { name, type, aliases, properties };
  g.entities[name] = entity;
  return entity;
}

export function addRelation(from: string, to: string, relation: RelationType, properties?: Record<string, string | number | boolean>): GraphRelation {
  const g = loadKnowledgeGraph();
  const rel: GraphRelation = { from, to, relation, properties };
  if (!g.relations.some((r) => r.from === from && r.to === to && r.relation === relation)) g.relations.push(rel);
  return rel;
}

// ─── Queries ────────────────────────────────────────────────────────────────

/** Find an entity by exact name, alias, or prefix (min 3 chars). */
export function getEntity(name: string): GraphEntity | null {
  const g = loadKnowledgeGraph();
  const lower = name.toLowerCase();
  if (g.entities[name]) return g.entities[name];
  for (const [key, ent] of Object.entries(g.entities)) {
    if (key.toLowerCase() === lower) return ent;
  }
  for (const ent of Object.values(g.entities)) {
    if (ent.aliases.some((a) => a.toLowerCase() === lower)) return ent;
  }
  if (lower.length >= 3) {
    for (const ent of Object.values(g.entities)) {
      if (ent.name.toLowerCase().startsWith(lower)) return ent;
    }
  }
  return null;
}

/** Find all entities related to entityName, optionally filtered by relation type. */
export function getRelated(entityName: string, relation?: RelationType): Array<{ entity: GraphEntity; relation: GraphRelation; direction: "outgoing" | "incoming" }> {
  const g = loadKnowledgeGraph();
  const results: Array<{ entity: GraphEntity; relation: GraphRelation; direction: "outgoing" | "incoming" }> = [];
  for (const rel of g.relations) {
    if (relation && rel.relation !== relation) continue;
    if (rel.from === entityName && g.entities[rel.to]) results.push({ entity: g.entities[rel.to], relation: rel, direction: "outgoing" });
    else if (rel.to === entityName && g.entities[rel.from]) results.push({ entity: g.entities[rel.from], relation: rel, direction: "incoming" });
  }
  return results;
}

/** A scored candidate for reference resolution. */
export interface ResolutionCandidate {
  entity: GraphEntity;
  score: number;
  reason: string;
}

/**
 * Resolve "it", "the server", "that service" using graph context + recent entities.
 * Returns the best candidate. Use resolveCandidates() for all scored options.
 */
export function resolveReference(text: string, recentEntities: string[]): GraphEntity | null {
  const candidates = resolveCandidates(text, recentEntities);
  return candidates.length > 0 ? candidates[0].entity : null;
}

/**
 * Get all resolution candidates, scored and ranked.
 * Scores: recent entity = 1.0 - (0.1 * position), type match = +0.2, relation match = +0.15
 */
export function resolveCandidates(text: string, recentEntities: string[]): ResolutionCandidate[] {
  const lower = text.toLowerCase().trim();
  const g = loadKnowledgeGraph();
  const candidates: ResolutionCandidate[] = [];

  // Direct match — highest confidence
  const direct = getEntity(lower);
  if (direct) return [{ entity: direct, score: 1.0, reason: "direct match" }];

  // Determine what type we're looking for
  let wantType: EntityType | null = null;
  const typed = lower.match(/^(?:the|that|this)\s+(server|service|database|container|port|package|llm|channel|path|user)$/);
  if (typed) wantType = typed[1] as EntityType;

  // For "it"/"that"/"this" — prefer services and containers (actionable things)
  const isAnaphoric = /^(it|that|this)$/.test(lower);
  if (isAnaphoric) wantType = null; // consider all types

  // Score recent entities
  for (let i = 0; i < recentEntities.length; i++) {
    const ent = g.entities[recentEntities[i]];
    if (!ent) continue;

    let score = 1.0 - (i * 0.15); // Recency: most recent = 1.0, then 0.85, 0.7, ...
    let reason = `recent entity (#${i + 1})`;

    // Type match bonus
    if (wantType && ent.type === wantType) {
      score += 0.2;
      reason += `, type match (${wantType})`;
    }

    // For "it" — prefer services/containers over servers/ports
    if (isAnaphoric) {
      if (ent.type === "service" || ent.type === "container") {
        score += 0.15;
        reason += ", actionable type";
      } else if (ent.type === "server") {
        score += 0.05;
        reason += ", server";
      }
    }

    // Relationship bonus — if this entity is related to other recent entities
    for (const other of recentEntities.slice(0, 3)) {
      if (other === recentEntities[i]) continue;
      const rels = g.relations.filter(r =>
        (r.from === ent.name && r.to === other) || (r.to === ent.name && r.from === other)
      );
      if (rels.length > 0) {
        score += 0.1;
        reason += `, related to ${other}`;
        break;
      }
    }

    candidates.push({ entity: ent, score: Math.min(score, 1.0), reason });
  }

  // If no recent entities matched and we want a type, search all entities of that type
  if (candidates.length === 0 && wantType) {
    for (const ent of Object.values(g.entities)) {
      if (ent.type === wantType) {
        candidates.push({ entity: ent, score: 0.3, reason: `type match (${wantType}), no recency` });
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/** Use relationships to infer intent context from tokens. Resolves anaphora and finds target/location. */
export function inferIntent(tokens: string[], recentEntities: string[] = []): {
  resolvedEntities: Array<{ token: string; entity: GraphEntity }>; impliedRelations: GraphRelation[];
  target?: GraphEntity; location?: GraphEntity;
} {
  const resolvedEntities: Array<{ token: string; entity: GraphEntity }> = [];
  const impliedRelations: GraphRelation[] = [];
  let target: GraphEntity | undefined, location: GraphEntity | undefined;

  for (const token of tokens) {
    const resolved = resolveReference(token, recentEntities) ?? getEntity(token);
    if (!resolved) continue;
    resolvedEntities.push({ token, entity: resolved });
    if (!target && (resolved.type === "service" || resolved.type === "container" || resolved.type === "package")) target = resolved;
    else if (!location && resolved.type === "server") location = resolved;
  }

  if (target && location) {
    const g = loadKnowledgeGraph();
    for (const rel of g.relations) {
      if ((rel.from === target.name && rel.to === location.name) || (rel.from === location.name && rel.to === target.name)) {
        impliedRelations.push(rel);
      }
    }
  }
  return { resolvedEntities, impliedRelations, target, location };
}

/** General-purpose query — find entities by type and/or property filter. */
export function queryGraph(filter: { type?: EntityType; property?: string; value?: string | number | boolean }): GraphEntity[] {
  const g = loadKnowledgeGraph();
  return Object.values(g.entities).filter((ent) => {
    if (filter.type && ent.type !== filter.type) return false;
    if (filter.property !== undefined) {
      const val = ent.properties[filter.property];
      if (val === undefined) return false;
      if (filter.value !== undefined && val !== filter.value) return false;
    }
    return true;
  });
}

// ─── Graph Builder ──────────────────────────────────────────────────────────

function loadRulesConfig(): Record<string, string[]> {
  for (const p of [
    join(import.meta.url.replace("file://", "").replace(/\/[^/]+\/[^/]+$/, ""), "../config/rules.json"),
    join(process.cwd(), "packages/core/config/rules.json"),
    join(process.cwd(), "config/rules.json"),
  ]) {
    if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf-8")).serviceAliases ?? {}; } catch { /* skip */ } }
  }
  return {};
}

function populateFromEntities(g: KnowledgeGraph, ents: EntitiesConfig): void {
  for (const [name, srv] of Object.entries(ents.servers)) {
    g.entities[name] = { name, type: "server", aliases: srv.aliases ?? [],
      properties: { host: srv.host, ...(srv.user ? { user: srv.user } : {}), ...(srv.description ? { description: srv.description } : {}) } };
    if (srv.host) g.relations.push({ from: name, to: `ip:${srv.host}`, relation: "has_ip" });
  }
  for (const [name, db] of Object.entries(ents.databases)) {
    g.entities[name] = { name, type: "database", aliases: db.aliases ?? [],
      properties: { dbType: db.type, host: db.host, dbName: db.name, ...(db.port ? { port: db.port } : {}), ...(db.user ? { user: db.user } : {}) } };
    if (db.port) g.relations.push({ from: name, to: `port:${db.port}`, relation: "has_port" });
  }
  for (const [id, inst] of Object.entries(ents.installations ?? {})) {
    const props: Record<string, string | number | boolean> = { service: inst.service, environment: inst.environment };
    if (inst.path) props.path = inst.path; if (inst.version) props.version = inst.version;
    if (inst.port) props.port = inst.port; if (inst.model) props.model = inst.model;
    if (inst.status) props.status = inst.status;
    g.entities[id] = { name: id, type: "service", aliases: inst.aliases ?? [], properties: props };
    if (inst.port) g.relations.push({ from: id, to: `port:${inst.port}`, relation: "has_port" });
    if (inst.model) {
      const llmName = `llm:${inst.model}`;
      if (!g.entities[llmName]) g.entities[llmName] = { name: llmName, type: "llm", aliases: [inst.model.split("/").pop()!], properties: { model: inst.model } };
      g.relations.push({ from: id, to: llmName, relation: "uses" });
    }
    const serverName = Object.keys(ents.servers).find((s) => inst.environment === s || inst.aliases.some((a) => a.includes(s)));
    if (serverName) g.relations.push({ from: id, to: serverName, relation: "runs_on" });
  }
}

function populateFromRules(g: KnowledgeGraph, serviceAliases: Record<string, string[]>): void {
  for (const [svc, aliases] of Object.entries(serviceAliases)) {
    if (!g.entities[svc]) { g.entities[svc] = { name: svc, type: "service", aliases, properties: {} }; }
    else { for (const a of aliases) { if (!g.entities[svc].aliases.includes(a)) g.entities[svc].aliases.push(a); } }
  }
}

function populateFromSystem(g: KnowledgeGraph): void {
  const tryExec = (cmd: string): string => { try { return execSync(cmd, { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim(); } catch { return ""; } };

  // Docker containers
  const dockerPs = tryExec("docker ps --format '{{.Names}}\\t{{.Image}}\\t{{.Ports}}' 2>/dev/null");
  for (const line of (dockerPs || "").split("\n").filter(Boolean)) {
    const [name, image, ports] = line.split("\t");
    if (name) g.entities[`container:${name}`] = { name: `container:${name}`, type: "container", aliases: [name], properties: { image: image ?? "", ports: ports ?? "" } };
  }

  // Listening ports
  const ssOut = tryExec("ss -tlnp 2>/dev/null | tail -n +2");
  for (const line of (ssOut || "").split("\n").filter(Boolean)) {
    const portM = line.match(/:(\d+)\s/), procM = line.match(/users:\(\("([^"]+)"/);
    if (!portM) continue;
    const key = `port:${portM[1]}`, proc = procM?.[1] ?? "unknown";
    if (!g.entities[key]) g.entities[key] = { name: key, type: "port", aliases: [`port ${portM[1]}`], properties: { port: Number(portM[1]), process: proc } };
    if (proc !== "unknown" && g.entities[proc]) g.relations.push({ from: proc, to: key, relation: "has_port" });
  }
}

/** Build the full knowledge graph from all sources. */
export function buildGraph(): KnowledgeGraph {
  const g: KnowledgeGraph = { entities: {}, relations: [], lastBuilt: new Date().toISOString() };
  populateFromEntities(g, loadEntities(true));
  populateFromRules(g, loadRulesConfig());
  populateFromSystem(g);
  return g;
}

/** Force a rebuild of the graph from all sources and persist. */
export function rebuildGraph(): KnowledgeGraph {
  _graph = buildGraph();
  saveKnowledgeGraph(_graph);
  return _graph;
}

// ─── Learning from execution ──────────────────────────────────────────────

/**
 * Learn from a successfully executed intent.
 * Grows the graph over time by recording:
 *   - Services that were restarted/checked (type: service)
 *   - Servers that were targeted (type: server)
 *   - Relationships discovered (service → runs_on → server)
 *   - New entities mentioned by the user
 *
 * Called after every successful execution. Persists periodically.
 */
let _learnCount = 0;

export function learnFromExecution(intent: string, fields: Record<string, unknown>, rawText: string): void {
  const g = loadKnowledgeGraph();
  const service = fields.service as string | undefined;
  const environment = fields.environment as string | undefined;
  const path = fields.path as string | undefined;
  const target = fields.target as string | undefined;

  // Learn services
  if (service && !g.entities[service]) {
    const type: EntityType = intent.startsWith("docker.") ? "container" : "service";
    g.entities[service] = { name: service, type, aliases: [], properties: {} };
  }

  // Learn servers/environments
  if (environment && environment !== "local" && environment !== "localhost" && environment !== "dev") {
    if (!g.entities[environment]) {
      g.entities[environment] = { name: environment, type: "server", aliases: [], properties: {} };
    }
    // Learn relationship: service runs_on environment
    if (service) {
      const rel: GraphRelation = { from: service, to: environment, relation: "runs_on" };
      if (!g.relations.some(r => r.from === rel.from && r.to === rel.to && r.relation === rel.relation)) {
        g.relations.push(rel);
      }
    }
  }

  // Learn paths
  if (path && path !== "." && !g.entities[`path:${path}`]) {
    g.entities[`path:${path}`] = { name: `path:${path}`, type: "path", aliases: [path], properties: { path } };
  }

  // Learn targets (from disk.scan, file operations, etc.)
  if (target && !g.entities[target]) {
    g.entities[target] = { name: target, type: "service", aliases: [], properties: {} };
  }

  // Learn from specific intents
  if (intent === "entity.define") {
    // User taught us a new entity — already handled by entityResolver
    // but mark the graph as needing a rebuild next time
    g.lastBuilt = undefined as unknown as string;
  }

  // Persist every 5 learn calls (not every single one — too much I/O)
  _learnCount++;
  if (_learnCount % 5 === 0) {
    saveKnowledgeGraph(g);
  }
}

/** Flush any pending graph changes to disk. */
export function flushGraph(): void {
  if (_graph) saveKnowledgeGraph(_graph);
}
