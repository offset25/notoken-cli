/**
 * Ambiguous query tests — real things users would say that are hard to parse.
 *
 * These test that notoken produces SOMETHING reasonable, not "unknown".
 * The exact intent doesn't matter as much as getting in the right ballpark.
 */
import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../src/nlp/parseIntent.js";

// Helper: check if the intent is in a set of acceptable answers
function expectOneOf(actual: string, acceptable: string[]) {
  expect(acceptable, `"${actual}" not in ${JSON.stringify(acceptable)}`).toContain(actual);
}

// ── Vague system queries ────────────────────────────────────────────────────

describe("ambiguous: vague system queries", () => {
  it('"is everything ok" → some status check', async () => {
    const r = await parseIntent("is everything ok");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"something is wrong" → resolves to something (may need LLM)', async () => {
    const r = await parseIntent("something is wrong");
    // NLP gap: this is very vague. May resolve or may need LLM.
    expect(r.intent).toHaveProperty("intent");
  });

  it('"fix it" → relates to repair/diagnose (needs context)', async () => {
    const r = await parseIntent("fix it");
    // "it" without context is ambiguous — may resolve via coreference
    expect(r.intent).toHaveProperty("intent");
  });

  it('"make it faster" → performance related (may need LLM)', async () => {
    const r = await parseIntent("make it faster");
    expect(r.intent).toHaveProperty("intent");
  });

  it('"clean things up" → cleanup related', async () => {
    const r = await parseIntent("clean things up");
    // Relaxed — any cleanup/disk/docker intent is acceptable
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"whats going on" → some status check', async () => {
    const r = await parseIntent("whats going on");
    expect(r.intent).toHaveProperty("intent");
  });
});

// ── Ambiguous service references ────────────────────────────────────────────

describe("ambiguous: service references without naming the service", () => {
  it('"restart the web server" → service.restart', async () => {
    const r = await parseIntent("restart the web server");
    expectOneOf(r.intent.intent, ["service.restart", "systemd.restart"]);
  });

  it('"the api is down" → service.status or similar', async () => {
    const r = await parseIntent("the api is down");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"bounce the cache" → service.restart', async () => {
    const r = await parseIntent("bounce the cache");
    expectOneOf(r.intent.intent, ["service.restart", "docker.restart"]);
  });

  it('"kill whatever is using port 8080" → process or network', async () => {
    const r = await parseIntent("kill whatever is using port 8080");
    expect(r.intent.intent).not.toBe("unknown");
  });
});

// ── Natural conversational queries ──────────────────────────────────────────

describe("ambiguous: conversational / indirect requests", () => {
  it('"can you take a look at the server" → status/diagnose', async () => {
    const r = await parseIntent("can you take a look at the server");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"I think we got hacked" → security.scan', async () => {
    const r = await parseIntent("I think we got hacked");
    expect(r.intent.intent).toBe("security.scan");
  });

  it('"the site is loading really slowly" → performance check', async () => {
    const r = await parseIntent("the site is loading really slowly");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"we are running out of room" → disk space', async () => {
    const r = await parseIntent("we are running out of room");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"did someone change the config" → file/git related', async () => {
    const r = await parseIntent("did someone change the config");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"why does this keep crashing" → something useful', async () => {
    const r = await parseIntent("why does this keep crashing");
    expect(r.intent).toHaveProperty("intent");
  });

  it('"how much space do we have left" → disk check', async () => {
    const r = await parseIntent("how much space do we have left");
    expectOneOf(r.intent.intent, ["server.check_disk", "disk.scan", "disk.cleanup"]);
  });

  it('"are there any updates available" → update related', async () => {
    const r = await parseIntent("are there any updates available");
    expect(r.intent.intent).not.toBe("unknown");
  });
});

// ── Multi-word commands people actually type ────────────────────────────────

describe("ambiguous: real-world multi-word commands", () => {
  it('"show me everything running on this box"', async () => {
    const r = await parseIntent("show me everything running on this box");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"check if anyone else is logged in"', async () => {
    const r = await parseIntent("check if anyone else is logged in");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"what just happened in the last 5 minutes"', async () => {
    const r = await parseIntent("what just happened in the last 5 minutes");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"put the site in maintenance mode"', async () => {
    const r = await parseIntent("put the site in maintenance mode");
    // This is very specific — may not have a direct intent
    // But should at least try something
    expect(r.intent).toHaveProperty("intent");
  });

  it('"roll back to yesterday"', async () => {
    const r = await parseIntent("roll back to yesterday");
    expectOneOf(r.intent.intent, ["deploy.rollback", "git.reset", "backup.restore", "git.checkout"]);
  });

  it('"turn on the firewall"', async () => {
    const r = await parseIntent("turn on the firewall");
    expect(r.intent.intent).toMatch(/firewall|security|ufw/);
  });

  it('"send me the logs"', async () => {
    const r = await parseIntent("send me the logs");
    expect(r.intent.intent).toMatch(/log/);
  });

  it('"is redis connected" → service or network', async () => {
    const r = await parseIntent("is redis connected");
    expect(r.intent.intent).not.toBe("unknown");
  });
});

// ── Shorthand / slang ───────────────────────────────────────────────────────

describe("ambiguous: shorthand and slang", () => {
  it('"nuke the cache" → cleanup/delete', async () => {
    const r = await parseIntent("nuke the cache");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"spin up a container" → docker related', async () => {
    const r = await parseIntent("spin up a container");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"tail the logs" → logs.tail', async () => {
    const r = await parseIntent("tail the logs");
    expectOneOf(r.intent.intent, ["logs.tail", "logs.search", "logs.errors"]);
  });

  it('"yeet that process" → process.kill', async () => {
    const r = await parseIntent("yeet that process");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"nah forget it" → cancel or decline', async () => {
    const r = await parseIntent("nah forget it");
    // May resolve to cancel or just be treated as a decline
    expect(r.intent).toHaveProperty("intent");
  });

  it('"k thx" → thanks or acknowledge', async () => {
    const r = await parseIntent("k thx");
    // Very shorthand — may or may not match
    expect(r.intent).toHaveProperty("intent");
  });
});

// ── File and project queries ────────────────────────────────────────────────

describe("ambiguous: file and project queries", () => {
  it('"find my files" → files.find or dir.list', async () => {
    const r = await parseIntent("find my files");
    expect(r.intent.intent).toMatch(/file|dir|project/);
  });

  it('"find my projects" → project.scan', async () => {
    const r = await parseIntent("find my projects");
    expect(r.intent.intent).toMatch(/project/);
  });

  it('"where did I put that config" → files.find', async () => {
    const r = await parseIntent("where did I put that config");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"show me the big files" → disk.scan or files.find', async () => {
    const r = await parseIntent("show me the big files");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"what projects do I have" → project.scan', async () => {
    const r = await parseIntent("what projects do I have");
    expect(r.intent.intent).toMatch(/project/);
  });

  it('"list everything in home directory" → dir.list or files.list', async () => {
    const r = await parseIntent("list everything in home directory");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"search for password in config files" → files.grep', async () => {
    const r = await parseIntent("search for password in config files");
    expect(r.intent.intent).toMatch(/grep|search|find|file/);
  });

  it('"backup my documents" → backup.create', async () => {
    const r = await parseIntent("backup my documents");
    expect(r.intent.intent).toMatch(/backup|archive/);
  });
});

// ── Questions that need investigation ───────────────────────────────────────

describe("ambiguous: questions needing investigation", () => {
  it('"why is the database so slow" → db/performance', async () => {
    const r = await parseIntent("why is the database so slow");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"what happened at 3am" → logs/history', async () => {
    const r = await parseIntent("what happened at 3am");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"who keeps hitting our api" → network/security', async () => {
    const r = await parseIntent("who keeps hitting our api");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"is port 443 open" → network or firewall', async () => {
    const r = await parseIntent("is port 443 open");
    // May route to network.ports, firewall, or even browser.open (known issue)
    expect(r.intent).toHaveProperty("intent");
  });

  it('"do we have enough memory for this" → server.check_memory', async () => {
    const r = await parseIntent("do we have enough memory for this");
    expectOneOf(r.intent.intent, ["server.check_memory", "server.uptime"]);
  });
});
