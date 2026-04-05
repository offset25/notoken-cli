import { describe, it, expect } from "vitest";
import { tokenize } from "../../../src/nlp/semantic.js";

const SERVICES = ["nginx", "redis", "api", "worker", "postgres"];
const ENVS = ["dev", "staging", "prod", "local"];

describe("tokenize", () => {
  it("tags action verbs correctly", () => {
    const tokens = tokenize("restart nginx on prod", SERVICES, ENVS);
    expect(tokens[0].tag).toBe("VERB");
    expect(tokens[0].text).toBe("restart");
  });

  it("tags known services", () => {
    const tokens = tokenize("restart nginx on prod", SERVICES, ENVS);
    const nginx = tokens.find((t) => t.text === "nginx");
    expect(nginx?.tag).toBe("SERVICE");
  });

  it("tags known environments", () => {
    const tokens = tokenize("restart nginx on prod", SERVICES, ENVS);
    const prod = tokens.find((t) => t.text === "prod");
    expect(prod?.tag).toBe("ENV");
  });

  it("tags prepositions", () => {
    const tokens = tokenize("copy file to /root", SERVICES, ENVS);
    const to = tokens.find((t) => t.text === "to");
    expect(to?.tag).toBe("PREP");
  });

  it("tags file paths", () => {
    const tokens = tokenize("copy file to /root", SERVICES, ENVS);
    const path = tokens.find((t) => t.text === "/root");
    expect(path?.tag).toBe("PATH");
  });

  it("tags numbers", () => {
    const tokens = tokenize("tail 200 lines", SERVICES, ENVS);
    const num = tokens.find((t) => t.text === "200");
    expect(num?.tag).toBe("NUMBER");
  });

  it("tags determiners", () => {
    const tokens = tokenize("restart the api", SERVICES, ENVS);
    const det = tokens.find((t) => t.text === "the");
    expect(det?.tag).toBe("DET");
  });

  it("fuzzy-matches typos to known services", () => {
    const tokens = tokenize("restart ngimx on prod", SERVICES, ENVS);
    const typo = tokens.find((t) => t.text === "ngimx");
    expect(typo?.tag).toBe("SERVICE");
    expect(typo?.normalized).toBe("nginx");
  });
});
