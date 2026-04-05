import { describe, it, expect } from "vitest";
import { normalizeUrl, formatBrowserStatus, type BrowserStatus } from "../../../src/utils/browser.js";

describe("normalizeUrl", () => {
  it("adds https:// to bare domains", () => {
    expect(normalizeUrl("google.com")).toBe("https://google.com");
    expect(normalizeUrl("notoken.sh")).toBe("https://notoken.sh");
    expect(normalizeUrl("example.com/path")).toBe("https://example.com/path");
  });

  it("adds http:// to localhost", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("localhost")).toBe("http://localhost");
  });

  it("adds http:// to 127.0.0.1", () => {
    expect(normalizeUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeUrl("127.0.0.1")).toBe("http://127.0.0.1");
  });

  it("adds http:// to 0.0.0.0", () => {
    expect(normalizeUrl("0.0.0.0:5000")).toBe("http://0.0.0.0:5000");
  });

  it("preserves existing https://", () => {
    expect(normalizeUrl("https://google.com")).toBe("https://google.com");
    expect(normalizeUrl("https://notoken.sh/docs")).toBe("https://notoken.sh/docs");
  });

  it("preserves existing http://", () => {
    expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("preserves file:// URLs", () => {
    expect(normalizeUrl("file:///tmp/test.html")).toBe("file:///tmp/test.html");
  });

  it("handles URLs with paths and query strings", () => {
    expect(normalizeUrl("example.com/page?q=test")).toBe("https://example.com/page?q=test");
  });
});

describe("formatBrowserStatus", () => {
  it("formats engine list with status indicators", () => {
    const engines: BrowserStatus[] = [
      { engine: "patchright", available: false },
      { engine: "playwright", available: true, version: "1.59.1", browsersInstalled: true },
      { engine: "docker", available: false },
      { engine: "system", available: true, version: "xdg-open" },
    ];
    const output = formatBrowserStatus(engines);
    expect(output).toContain("Browser Engines");
    expect(output).toContain("patchright");
    expect(output).toContain("playwright");
    expect(output).toContain("docker");
    expect(output).toContain("system");
    expect(output).toContain("not installed");
    expect(output).toContain("ready");
  });

  it("indicates when browsers are missing for installed engine", () => {
    const engines: BrowserStatus[] = [
      { engine: "patchright", available: true, version: "1.0.0", browsersInstalled: false },
      { engine: "system", available: true },
    ];
    const output = formatBrowserStatus(engines);
    expect(output).toContain("no browsers");
  });

  it("shows screenshots directory", () => {
    const engines: BrowserStatus[] = [
      { engine: "system", available: true },
    ];
    const output = formatBrowserStatus(engines);
    expect(output).toContain("screenshots");
  });
});
