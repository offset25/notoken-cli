import { describe, it, expect } from "vitest";
import { parseByRules } from "../../../packages/core/src/nlp/ruleParser.js";

describe("parseByRules", () => {
  it("parses restart service with environment", () => {
    const result = parseByRules("restart nginx on prod");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("service.restart");
    expect(result!.fields.service).toBe("nginx");
    expect(result!.fields.environment).toBe("prod");
    expect(result!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("parses disk check", () => {
    const result = parseByRules("check disk usage on staging");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("server.check_disk");
    expect(result!.fields.environment).toBe("staging");
  });

  it("parses tail logs with line count", () => {
    const result = parseByRules("tail 200 api logs in production");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("logs.tail");
    expect(result!.fields.lines).toBe(200);
    expect(result!.fields.service).toBe("api");
    expect(result!.fields.environment).toBe("prod");
  });

  it("parses deploy with branch", () => {
    const result = parseByRules("deploy main to staging");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("deploy.run");
    expect(result!.fields.branch).toBe("main");
    expect(result!.fields.environment).toBe("staging");
  });

  it("returns null for unrecognized input", () => {
    const result = parseByRules("something completely unknown xyz");
    expect(result).toBeNull();
  });

  it("resolves environment aliases", () => {
    const result = parseByRules("restart nginx on production");
    expect(result).not.toBeNull();
    expect(result!.fields.environment).toBe("prod");
  });

  it("resolves service aliases", () => {
    const result = parseByRules("restart cache on prod");
    expect(result).not.toBeNull();
    expect(result!.fields.service).toBe("redis");
  });

  it("parses copy with source and destination", () => {
    const result = parseByRules("copy nginx.conf to /root on prod");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("files.copy");
    expect(result!.fields.source).toBe("nginx.conf");
    expect(result!.fields.destination).toBe("/root");
    expect(result!.fields.environment).toBe("prod");
  });

  it("parses move with source and destination", () => {
    const result = parseByRules("move app.log to /backup on staging");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("files.move");
    expect(result!.fields.environment).toBe("staging");
  });

  it("parses ssh connect", () => {
    const result = parseByRules("ssh into prod");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("ssh.connect");
    expect(result!.fields.environment).toBe("prod");
  });
});
