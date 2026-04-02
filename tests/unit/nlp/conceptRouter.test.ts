import { describe, it, expect } from "vitest";
import { routeByConcepts } from "../../../packages/core/src/nlp/conceptRouter.js";

describe("concept router", () => {
  // Image generation domain
  it("routes 'is this offline or cloud' to image status", () => {
    const r = routeByConcepts("is this happening offline or locally is it free or using cloud");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("ai.image_status");
  });

  it("routes 'what are we using to generate images' to image status", () => {
    const r = routeByConcepts("what are we using to generate images");
    expect(r).not.toBeNull();
    expect(r!.intent).toContain("ai.");
  });

  // Cron
  it("routes 'check what crontabs I have' to cron.list", () => {
    const r = routeByConcepts("can you check what crontabs I have running");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("cron.list");
  });

  // Memory / hardware
  it("routes 'how much ram' to hardware or memory", () => {
    const r = routeByConcepts("how much ram does this machine have");
    expect(r).not.toBeNull();
    expect(["server.check_memory", "hardware.info"]).toContain(r!.intent);
  });

  // Disk
  it("routes 'disk space' to server.check_disk", () => {
    const r = routeByConcepts("what is eating up my disk space");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("server.check_disk");
  });

  // Docker
  it("routes 'containers running' to docker", () => {
    const r = routeByConcepts("show me what containers are running");
    expect(r).not.toBeNull();
    expect(r!.intent).toContain("docker");
  });

  // Files
  it("routes 'what files' to dir.list", () => {
    const r = routeByConcepts("what files do I have in this folder");
    expect(r).not.toBeNull();
    expect(["dir.list", "files.find"]).toContain(r!.intent);
  });

  it("routes 'projects here' to project.scan", () => {
    const r = routeByConcepts("what projects do I have here");
    expect(r).not.toBeNull();
    expect(["project.scan", "project.info"]).toContain(r!.intent);
  });

  // Media
  it("routes 'find my movies' to media or files domain", () => {
    const r = routeByConcepts("where are my movies and music files");
    expect(r).not.toBeNull();
    expect(r!.concepts).toContain("movie");
    expect(["files.find_media", "dir.list"].includes(r!.intent)).toBe(true);
  });

  // Network
  it("routes 'what is my ip' to network.ip", () => {
    const r = routeByConcepts("what is my ip address");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("network.ip");
  });

  // Firewall / network ports
  it("routes 'open port' to firewall or network ports", () => {
    const r = routeByConcepts("can you open port 8080 for me");
    expect(r).not.toBeNull();
    expect(r!.concepts).toContain("port");
    expect(r!.intent.includes("firewall") || r!.intent.includes("network")).toBe(true);
  });

  // Question detection
  it("detects questions correctly", () => {
    const q1 = routeByConcepts("is my disk full");
    expect(q1?.isQuestion).toBe(true);

    const q2 = routeByConcepts("restart the docker container");
    expect(q2?.isQuestion).toBe(false);
  });

  // Returns null for gibberish
  it("returns null for unrecognized input", () => {
    const r = routeByConcepts("xyzzy plonk quux wibble");
    expect(r).toBeNull();
  });

  // Confidence scoring
  it("returns reasonable confidence", () => {
    const r = routeByConcepts("check my crontabs");
    expect(r).not.toBeNull();
    expect(r!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r!.confidence).toBeLessThanOrEqual(1.0);
  });
});
