import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../src/nlp/parseIntent.js";

const chatPhrases = [
  // Greetings
  { input: "hello", expected: "chat.greeting" },
  { input: "hey", expected: "chat.greeting" },
  { input: "good morning", expected: "chat.greeting" },
  { input: "yo", expected: "chat.greeting" },
  { input: "howdy", expected: "chat.greeting" },
  // How are you
  { input: "how are you", expected: "chat.howru" },
  { input: "how are you doing", expected: "chat.howru" },
  { input: "how is it going", expected: "chat.howru" },
  { input: "you ok", expected: "chat.howru" },
  // Thanks
  { input: "thanks", expected: "chat.thanks" },
  { input: "thank you", expected: "chat.thanks" },
  { input: "good job", expected: "chat.thanks" },
  { input: "appreciate it", expected: "chat.thanks" },
  // Bye
  { input: "bye", expected: "chat.bye" },
  { input: "goodbye", expected: "chat.bye" },
  { input: "see you", expected: "chat.bye" },
  { input: "take care", expected: "chat.bye" },
  // About
  { input: "who are you", expected: "chat.about" },
  { input: "what is notoken", expected: "chat.about" },
  // Jokes
  { input: "tell me a joke", expected: "chat.joke" },
  { input: "make me laugh", expected: "chat.joke" },
  // Empathy
  { input: "this is frustrating", expected: "chat.empathy" },
  { input: "i am confused", expected: "chat.empathy" },
  { input: "i am stuck", expected: "chat.empathy" },
  // Compliment
  { input: "you're awesome", expected: "chat.compliment" },
  { input: "you rock", expected: "chat.compliment" },
  { input: "love it", expected: "chat.compliment" },
  // Insult
  { input: "you suck", expected: "chat.insult" },
  { input: "you're stupid", expected: "chat.insult" },
  // Capabilities
  { input: "what else can you do", expected: "chat.capabilities" },
  { input: "show me what you can do", expected: "chat.capabilities" },
  // Bored
  { input: "i'm bored", expected: "chat.empathy" }, // empathy catches "bored" first
  { input: "entertain me", expected: "chat.bored" },
  { input: "surprise me", expected: "chat.bored" },
  // Existential
  { input: "are you alive", expected: "chat.existential" },
  { input: "are you real", expected: "chat.existential" },
  { input: "do you dream", expected: "chat.existential" },
  // Motivate
  { input: "motivate me", expected: "chat.motivate" },
  { input: "inspire me", expected: "chat.motivate" },
  // Fact
  { input: "tell me a fact", expected: "chat.fact" },
  { input: "fun fact", expected: "chat.fact" },
  // Easter eggs
  { input: "42", expected: "chat.easter" },
  { input: "sudo make me a sandwich", expected: "chat.easter" },
  { input: "meaning of life", expected: "chat.easter" },
  // Sorry
  { input: "sorry", expected: "chat.sorry" },
  { input: "my bad", expected: "chat.sorry" },
  { input: "oops", expected: "chat.sorry" },
  // Acknowledge
  { input: "cool", expected: "chat.acknowledge" },
  { input: "nice", expected: "chat.compliment" }, // compliment catches "nice" first
  { input: "sweet", expected: "chat.acknowledge" },
  // Age
  { input: "how old are you", expected: "chat.age" },
  { input: "when were you created", expected: "chat.age" },
  // Favorite
  { input: "what is your favorite language", expected: "chat.favorite" },
];

describe("chat intent routing", () => {
  for (const { input, expected } of chatPhrases) {
    it(`"${input}" → ${expected}`, async () => {
      const result = await parseIntent(input);
      expect(result.intent.intent).toBe(expected);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(0.9);
    });
  }
});

describe("chat responses are not empty", () => {
  it("loads chat-responses.json with all categories", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const data = JSON.parse(readFileSync(resolve(process.cwd(), "config/chat-responses.json"), "utf-8"));
    const categories = Object.keys(data.responses);

    expect(categories.length).toBeGreaterThanOrEqual(22);

    for (const cat of categories) {
      expect(data.responses[cat].length, `${cat} should have responses`).toBeGreaterThan(0);
    }
  });

  it("has at least 600 total responses", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const data = JSON.parse(readFileSync(resolve(process.cwd(), "config/chat-responses.json"), "utf-8"));
    const total = Object.values(data.responses).reduce((sum: number, arr: unknown) => sum + (arr as string[]).length, 0);
    expect(total).toBeGreaterThanOrEqual(600);
  });
});
