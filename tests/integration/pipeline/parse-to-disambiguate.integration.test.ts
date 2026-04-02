import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../packages/core/src/nlp/parseIntent.js";

describe("parse → disambiguate pipeline", () => {
  it("parses and disambiguates a clear command", async () => {
    const result = await parseIntent("restart nginx on prod");
    expect(result.intent.intent).toBe("service.restart");
    expect(result.needsClarification).toBe(false);
    expect(result.missingFields).toHaveLength(0);
  });

  it("flags unknown input for self-healing", async () => {
    const result = await parseIntent("xyzzy foobar baz");
    expect(result.intent.intent).toBe("unknown");
    expect(result.needsClarification).toBe(true);
  });

  it("resolves environment aliases through full pipeline", async () => {
    const result = await parseIntent("deploy main to production");
    expect(result.intent.intent).toBe("deploy.run");
    expect(result.intent.fields.environment).toBe("prod");
  });

  it("handles copy with source/destination extraction", async () => {
    const result = await parseIntent("copy nginx.conf to /root on prod");
    expect(result.intent.intent).toBe("files.copy");
    expect(result.intent.fields.source).toBe("nginx.conf");
    expect(result.intent.fields.destination).toBe("/root");
  });

  it("computes confidence above threshold for known commands", async () => {
    const result = await parseIntent("show disk usage on staging");
    expect(result.intent.confidence).toBeGreaterThanOrEqual(0.7);
  });
});
