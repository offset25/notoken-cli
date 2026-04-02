import { describe, it, expect } from "vitest";
import { getFileInfo, smartRead, smartSearch } from "../../../packages/core/src/utils/smartFile.js";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());

describe("getFileInfo", () => {
  it("returns info for existing file", async () => {
    const info = await getFileInfo(resolve(ROOT, "package.json"), false);
    expect(info.exists).toBe(true);
    expect(info.sizeBytes).toBeGreaterThan(0);
    expect(info.lineCount).toBeGreaterThan(0);
  });

  it("returns exists=false for missing file", async () => {
    const info = await getFileInfo("/nonexistent/file.txt", false);
    expect(info.exists).toBe(false);
  });

  it("detects large files correctly", async () => {
    const info = await getFileInfo(resolve(ROOT, "packages/core/config/intents.json"), false);
    expect(info.exists).toBe(true);
    // intents.json is ~4000 lines, should be flagged as big
    expect(info.isBig).toBe(true);
  });

  it("detects small files correctly", async () => {
    const info = await getFileInfo(resolve(ROOT, "package.json"), false);
    expect(info.isBig).toBe(false);
  });
});

describe("smartRead", () => {
  it("shows full content for small files", async () => {
    const output = await smartRead(resolve(ROOT, "packages/core/tsconfig.json"), false);
    expect(output).toContain("tsconfig.json");
    expect(output).toContain("compilerOptions");
    // Should NOT have "Large file" warning
    expect(output).not.toContain("Large file");
  });

  it("shows sample for large files", async () => {
    const output = await smartRead(resolve(ROOT, "packages/core/config/intents.json"), false);
    expect(output).toContain("Large file");
    expect(output).toContain("First 30 lines");
    expect(output).toContain("Last 30 lines");
    expect(output).toContain("lines omitted");
  });

  it("returns error for missing file", async () => {
    const output = await smartRead("/nonexistent/file.txt", false);
    expect(output).toContain("not found");
  });
});

describe("smartSearch", () => {
  it("finds matches in a file", async () => {
    const output = await smartSearch(resolve(ROOT, "package.json"), "vitest", false);
    expect(output).toContain("vitest");
    expect(output).toContain("match");
  });

  it("shows context lines around matches", async () => {
    const output = await smartSearch(resolve(ROOT, "package.json"), "compromise", false);
    // Should show the compromise line plus surrounding lines
    expect(output).toContain("compromise");
  });

  it("reports no matches gracefully", async () => {
    const output = await smartSearch(resolve(ROOT, "package.json"), "xyznonexistent", false);
    expect(output).toContain("No matches");
  });

  it("returns error for missing file", async () => {
    const output = await smartSearch("/nonexistent/file.txt", "test", false);
    expect(output).toContain("not found");
  });
});
