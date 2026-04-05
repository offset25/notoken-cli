import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../src/nlp/parseIntent.js";

describe("weather.current intent fixtures", () => {
  const phrases = [
    { input: "whats the weather", expectedIntent: "weather.current" },
    { input: "weather today", expectedIntent: "weather.current" },
    { input: "weather in new york", expectedIntent: "weather.current" },
    { input: "is it going to rain", expectedIntent: "weather.current" },
    { input: "how is the weather", expectedIntent: "weather.current" },
    { input: "temperature outside", expectedIntent: "weather.current" },
    { input: "weather forecast", expectedIntent: "weather.current" },
    { input: "whats it like outside", expectedIntent: "weather.current" },
  ];

  for (const phrase of phrases) {
    it(`"${phrase.input}" → ${phrase.expectedIntent}`, async () => {
      const result = await parseIntent(phrase.input);
      expect(result.intent.intent).toBe(phrase.expectedIntent);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }

  it("extracts location from 'weather in tokyo'", async () => {
    const result = await parseIntent("weather in tokyo");
    expect(result.intent.intent).toBe("weather.current");
    expect(result.intent.fields.location).toBe("tokyo");
  });
});

describe("news.headlines intent fixtures", () => {
  const phrases = [
    { input: "latest news", expectedIntent: "news.headlines" },
    { input: "whats the latest news", expectedIntent: "news.headlines" },
    { input: "show me headlines", expectedIntent: "news.headlines" },
    { input: "any news today", expectedIntent: "news.headlines" },
    { input: "top stories", expectedIntent: "news.headlines" },
  ];

  for (const phrase of phrases) {
    it(`"${phrase.input}" → ${phrase.expectedIntent}`, async () => {
      const result = await parseIntent(phrase.input);
      expect(result.intent.intent).toBe(phrase.expectedIntent);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }
});

describe("db.size intent fixtures", () => {
  const phrases = [
    { input: "how big is my database", expectedIntent: "db.size" },
    { input: "database size", expectedIntent: "db.size" },
    { input: "how much space does the database use", expectedIntent: "db.size" },
    { input: "db storage", expectedIntent: "db.size" },
  ];

  for (const phrase of phrases) {
    it(`"${phrase.input}" → ${phrase.expectedIntent}`, async () => {
      const result = await parseIntent(phrase.input);
      expect(result.intent.intent).toBe(phrase.expectedIntent);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }
});

describe("user.delete intent fixtures", () => {
  it('"delete user john" → user.delete', async () => {
    const result = await parseIntent("delete user john");
    expect(result.intent.intent).toBe("user.delete");
  });

  it('"remove user testuser" → user.delete', async () => {
    const result = await parseIntent("remove user testuser");
    expect(result.intent.intent).toBe("user.delete");
  });
});

describe("newly routed intents", () => {
  const phrases = [
    { input: "what time is it", expected: "system.datetime" },
    { input: "who am i", expected: "user.whoami" },
    { input: "who is logged in", expected: "user.who" },
    { input: "show running services", expected: "service.list" },
    { input: "what is my ip address", expected: "network.ip" },
    { input: "is the network slow", expected: "network.speedtest" },
    { input: "any errors in the logs", expected: "logs.errors" },
    { input: "find large files", expected: "disk.scan" },
    { input: "check if website is up", expected: "network.curl" },
    { input: "what is using heavy cpu", expected: "process.list" },
    { input: "are we under attack", expected: "security.scan" },
    { input: "any viruses on this computer", expected: "security.scan" },
    { input: "show me whats on this drive", expected: "disk.scan" },
    { input: "what is in my documents folder", expected: "dir.list" },
    { input: "how is openclaw doing", expected: "openclaw.status" },
  ];

  for (const { input, expected } of phrases) {
    it(`"${input}" → ${expected}`, async () => {
      const result = await parseIntent(input);
      expect(result.intent.intent).toBe(expected);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }
});
