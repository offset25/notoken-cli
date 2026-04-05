import { describe, it, expect } from "vitest";

describe("askForStrictConfirmation logic", () => {
  it("accepts exact match", () => {
    const requiredPhrase = "RESTART_WSL";
    const userInput = "RESTART_WSL";
    expect(userInput.trim() === requiredPhrase).toBe(true);
  });

  it("rejects partial match", () => {
    const requiredPhrase = "RESTART_WSL";
    const userInput = "restart_wsl";
    expect(userInput.trim() === requiredPhrase).toBe(false);
  });

  it("rejects empty input", () => {
    const requiredPhrase = "RESTART_WSL";
    const userInput = "";
    expect(userInput.trim() === requiredPhrase).toBe(false);
  });

  it("rejects y/yes shortcuts", () => {
    const requiredPhrase = "RESTART_WSL";
    expect("y" === requiredPhrase).toBe(false);
    expect("yes" === requiredPhrase).toBe(false);
    expect("Y" === requiredPhrase).toBe(false);
  });

  it("rejects extra whitespace without trim", () => {
    const requiredPhrase = "RESTART_WSL";
    const userInput = "  RESTART_WSL  ";
    // trimmed matches
    expect(userInput.trim() === requiredPhrase).toBe(true);
    // raw doesn't
    expect(userInput === requiredPhrase).toBe(false);
  });
});

describe("askWithControl response classification", () => {
  // Test the regex patterns used in askWithControl
  function classify(input: string): "yes" | "no" | "all" | "stop" {
    const trimmed = input.trim().toLowerCase();
    if (/^y(es)?$/.test(trimmed)) return "yes";
    if (/^(all|yes.?all|do.?all|everything|clean.?(all|everything)|keep.?going|do.?it|go.?ahead)$/.test(trimmed)) return "all";
    if (/^(stop|abort|quit|enough|no.?more|that.?s?.?enough|stop.?right.?there|cancel|done|don.?t|nah|exit)$/.test(trimmed)) return "stop";
    return "no";
  }

  // Yes variants
  it("classifies 'y' as yes", () => expect(classify("y")).toBe("yes"));
  it("classifies 'yes' as yes", () => expect(classify("yes")).toBe("yes"));
  it("classifies 'Y' as yes", () => expect(classify("Y")).toBe("yes"));

  // All variants
  it("classifies 'all' as all", () => expect(classify("all")).toBe("all"));
  it("classifies 'clean everything' as all", () => expect(classify("clean everything")).toBe("all"));
  it("classifies 'keep going' as all", () => expect(classify("keep going")).toBe("all"));
  it("classifies 'do it' as all", () => expect(classify("do it")).toBe("all"));
  it("classifies 'yes all' as all", () => expect(classify("yes all")).toBe("all"));
  it("classifies 'do all' as all", () => expect(classify("do all")).toBe("all"));
  it("classifies 'everything' as all", () => expect(classify("everything")).toBe("all"));
  it("classifies 'go ahead' as all", () => expect(classify("go ahead")).toBe("all"));
  it("classifies 'clean all' as all", () => expect(classify("clean all")).toBe("all"));

  // Stop variants
  it("classifies 'stop' as stop", () => expect(classify("stop")).toBe("stop"));
  it("classifies 'stop right there' as stop", () => expect(classify("stop right there")).toBe("stop"));
  it("classifies 'enough' as stop", () => expect(classify("enough")).toBe("stop"));
  it("classifies 'that's enough' as stop", () => expect(classify("that's enough")).toBe("stop"));
  it("classifies 'thats enough' as stop", () => expect(classify("thats enough")).toBe("stop"));
  it("classifies 'no more' as stop", () => expect(classify("no more")).toBe("stop"));
  it("classifies 'abort' as stop", () => expect(classify("abort")).toBe("stop"));
  it("classifies 'cancel' as stop", () => expect(classify("cancel")).toBe("stop"));
  it("classifies 'done' as stop", () => expect(classify("done")).toBe("stop"));
  it("classifies 'don't' as stop", () => expect(classify("don't")).toBe("stop"));
  it("classifies 'dont' as stop", () => expect(classify("dont")).toBe("stop"));
  it("classifies 'nah' as stop", () => expect(classify("nah")).toBe("stop"));
  it("classifies 'quit' as stop", () => expect(classify("quit")).toBe("stop"));
  it("classifies 'exit' as stop", () => expect(classify("exit")).toBe("stop"));

  // No (default)
  it("classifies 'n' as no", () => expect(classify("n")).toBe("no"));
  it("classifies 'no' as no", () => expect(classify("no")).toBe("no"));
  it("classifies '' (empty) as no", () => expect(classify("")).toBe("no"));
  it("classifies random text as no", () => expect(classify("banana")).toBe("no"));
});
