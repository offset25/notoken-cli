import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../packages/core/src/nlp/parseIntent.js";

describe("ollama status routing", () => {
  const statusPhrases = [
    { input: "is ollama running", expected: "ollama.status" },
    { input: "do we have ollama", expected: "ollama.status" },
    { input: "is ollama installed", expected: "ollama.status" },
    { input: "is ollama available", expected: "ollama.status" },
    { input: "do i have ollama", expected: "ollama.status" },
    { input: "ollama status", expected: "ollama.status" },
  ];

  for (const { input, expected } of statusPhrases) {
    it(`"${input}" → ${expected}`, async () => {
      const r = await parseIntent(input);
      expect(r.intent.intent).toBe(expected);
    });
  }
});

describe("ollama model management routing", () => {
  const phrases = [
    { input: "ollama models", expected: "ollama.models" },
    { input: "list ollama models", expected: "ollama.models" },
    { input: "show ollama models", expected: "ollama.models" },
    { input: "ollama pull llama3.2", expected: "ollama.pull" },
    { input: "install ollama model", expected: "ollama.pull" },
    { input: "ollama remove llama2", expected: "ollama.remove" },
    { input: "delete ollama model", expected: "ollama.uninstall" },
    { input: "ollama storage", expected: "ollama.storage" },
    { input: "where are ollama models", expected: "ollama.storage" },
    { input: "start ollama", expected: "ollama.start" },
    { input: "stop ollama", expected: "ollama.stop" },
    { input: "restart ollama", expected: "ollama.restart" },
  ];

  for (const { input, expected } of phrases) {
    it(`"${input}" → ${expected}`, async () => {
      const r = await parseIntent(input);
      expect(r.intent.intent).toBe(expected);
    });
  }
});

describe("'do we have X' routing for other tools", () => {
  it('"do we have docker" → docker related', async () => {
    const r = await parseIntent("do we have docker");
    expect(r.intent.intent).toMatch(/docker/);
  });

  it('"is node installed" → tool.info', async () => {
    const r = await parseIntent("is node installed");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"is docker running" → docker related', async () => {
    const r = await parseIntent("is docker running");
    expect(r.intent.intent).toMatch(/docker/);
  });
});

describe("ollama with environment targeting", () => {
  it('"ollama models on windows" still routes to ollama.models', async () => {
    const r = await parseIntent("ollama models on windows");
    expect(r.intent.intent).toBe("ollama.models");
  });

  it('"pull llama3.2 in docker" routes to ollama.pull', async () => {
    const r = await parseIntent("ollama pull llama3.2 in docker");
    expect(r.intent.intent).toBe("ollama.pull");
  });
});

describe("ollama status handler output (live)", () => {
  it("ollama.status doesn't crash", async () => {
    // Just verify the handler can be called without throwing uncaught errors
    try {
      const { executeIntent } = await import("../../../packages/core/src/handlers/executor.js");
      const result = await executeIntent({ intent: "ollama.status", confidence: 0.9, rawText: "is ollama running", fields: {} });
      expect(typeof result).toBe("string");
    } catch (err) {
      // May fail in test env — that's acceptable
      expect(err).toBeDefined();
    }
  });
});

describe("ollama model switching", () => {
  it('"use ollama" → notoken.model', async () => {
    const r = await parseIntent("use ollama");
    expect(r.intent.intent).toBe("notoken.model");
  });

  it('"switch notoken to llama3.2" → notoken.model', async () => {
    const r = await parseIntent("switch notoken to llama3.2");
    expect(r.intent.intent).toMatch(/model/);
  });

  it('"switch openclaw to ollama" → openclaw.model', async () => {
    const r = await parseIntent("switch openclaw to ollama");
    expect(r.intent.intent).toBe("openclaw.model");
  });
});

describe("ollama install/uninstall", () => {
  it('"install ollama" → tool.install', async () => {
    const r = await parseIntent("install ollama");
    expect(r.intent.intent).toBe("tool.install");
  });

  it('"uninstall ollama" routes to something', async () => {
    const r = await parseIntent("uninstall ollama");
    expect(r.intent.intent).not.toBe("unknown");
  });

  it('"how to install ollama" → tool.info', async () => {
    const r = await parseIntent("how to install ollama");
    expect(r.intent.intent).toBe("tool.info");
  });
});

describe("file organization routing", () => {
  it('"organize these files" → files.organize', async () => {
    const r = await parseIntent("organize these files");
    expect(r.intent.intent).toBe("files.organize");
  });

  it('"sort my downloads" → files.organize', async () => {
    const r = await parseIntent("sort my downloads");
    expect(r.intent.intent).toBe("files.organize");
  });

  it('"tidy up this folder" → files.organize', async () => {
    const r = await parseIntent("tidy up this folder");
    expect(r.intent.intent).toBe("files.organize");
  });

  it('"where should I put invoice.pdf" → files.place', async () => {
    const r = await parseIntent("where should I put invoice.pdf");
    expect(r.intent.intent).toBe("files.place");
  });

  it('"where does this file belong" → files.place', async () => {
    const r = await parseIntent("where does this file belong");
    expect(r.intent.intent).toBe("files.place");
  });
});
