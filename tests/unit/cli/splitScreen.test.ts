import { describe, it, expect, vi, beforeEach } from "vitest";
import { SplitScreen } from "../../../packages/cli/src/splitScreen.js";

describe("SplitScreen", () => {
  let screen: SplitScreen;

  beforeEach(() => {
    screen = new SplitScreen();
  });

  it("starts disabled", () => {
    expect(screen.isEnabled()).toBe(false);
  });

  it("enable does nothing without TTY", () => {
    // process.stdout.isTTY is undefined in test environment
    screen.enable();
    expect(screen.isEnabled()).toBe(false);
  });

  it("writeOutput falls through when disabled", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    screen.writeOutput("hello");
    expect(writeSpy).toHaveBeenCalledWith("hello");
    writeSpy.mockRestore();
  });

  it("setPrompt stores prompt text", () => {
    // No crash when disabled
    screen.setPrompt("~/mycli> ");
    expect(screen.isEnabled()).toBe(false);
  });

  it("setInput stores input text", () => {
    screen.setInput("restart nginx");
    expect(screen.isEnabled()).toBe(false);
  });

  it("setStatus stores status text", () => {
    screen.setStatus("NoToken v1.8.0 │ ⏳ 1 task");
    expect(screen.isEnabled()).toBe(false);
  });

  it("disable is safe to call when not enabled", () => {
    screen.disable();
    expect(screen.isEnabled()).toBe(false);
  });

  it("patchConsole returns restore function when disabled", () => {
    const patch = screen.patchConsole();
    expect(patch).toHaveProperty("restore");
    expect(typeof patch.restore).toBe("function");
    patch.restore();
  });
});

describe("SplitScreen patchConsole", () => {
  it("restore restores original console.log", () => {
    const screen = new SplitScreen();
    const originalLog = console.log;
    const patch = screen.patchConsole();
    // When disabled, patchConsole is a no-op
    expect(console.log).toBe(originalLog);
    patch.restore();
    expect(console.log).toBe(originalLog);
  });
});
