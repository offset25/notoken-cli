import { describe, it, expect } from "vitest";
import { routeByConcepts } from "../../../src/nlp/conceptRouter.js";

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

  // ── Complex multi-part statements ──

  it("handles 'why is my server so slow and what is using all the cpu'", () => {
    const r = routeByConcepts("why is my server so slow and what is using all the cpu");
    expect(r).not.toBeNull();
    expect(["server.uptime", "hardware.info", "server.check_memory"]).toContain(r!.intent);
    expect(r!.concepts.length).toBeGreaterThanOrEqual(1);
  });

  it("handles 'is docker running and are any containers using too much memory'", () => {
    const r = routeByConcepts("is docker running and are any containers using too much memory");
    expect(r).not.toBeNull();
    expect(r!.concepts).toContain("docker");
    expect(r!.concepts).toContain("memory");
  });

  it("handles 'i need to check if the firewall is blocking port 443 and also check dns for my domain'", () => {
    const r = routeByConcepts("i need to check if the firewall is blocking port 443 and also check dns for my domain");
    expect(r).not.toBeNull();
    expect(r!.concepts.length).toBeGreaterThanOrEqual(2);
    // Should match firewall or dns or network
    expect(r!.intent.includes("firewall") || r!.intent.includes("dns") || r!.intent.includes("network")).toBe(true);
  });

  it("handles 'can you tell me how much disk space is left and also show me what processes are eating memory'", () => {
    const r = routeByConcepts("can you tell me how much disk space is left and also show me what processes are eating memory");
    expect(r).not.toBeNull();
    expect(["server.check_disk", "server.check_memory"]).toContain(r!.intent);
  });

  it("handles 'what projects are in my home directory and do any of them have docker compose files'", () => {
    const r = routeByConcepts("what projects are in my home directory and do any of them have docker compose files");
    expect(r).not.toBeNull();
    expect(r!.concepts.length).toBeGreaterThanOrEqual(2);
  });

  it("handles 'i want to generate some images but first tell me if its running locally or in the cloud'", () => {
    const r = routeByConcepts("i want to generate some images but first tell me if its running locally or in the cloud");
    expect(r).not.toBeNull();
    expect(r!.intent).toContain("ai.");
  });

  it("handles 'set up a cron job to check disk space every hour and send me an alert if it goes above 90 percent'", () => {
    const r = routeByConcepts("set up a cron job to check disk space every hour and send me an alert if it goes above 90 percent");
    expect(r).not.toBeNull();
    expect(r!.concepts).toContain("cron");
  });

  it("handles 'is nginx running, what port is it on, and can you show me the recent error logs'", () => {
    const r = routeByConcepts("is nginx running what port is it on and can you show me the recent error logs");
    expect(r).not.toBeNull();
    expect(r!.concepts.length).toBeGreaterThanOrEqual(1);
  });

  it("handles 'my website is down can you check if the dns is resolving and if the server is reachable'", () => {
    const r = routeByConcepts("my website is down can you check if the dns is resolving and if the server is reachable");
    expect(r).not.toBeNull();
    expect(r!.concepts).toContain("dns");
    // May route to dns, network, or browser domain depending on weights
    expect(r!.intent.includes("dns") || r!.intent.includes("network") || r!.intent.includes("browser")).toBe(true);
  });

  it("handles 'show me all the media files like videos photos and music on this machine'", () => {
    const r = routeByConcepts("show me all the media files like videos photos and music on this machine");
    expect(r).not.toBeNull();
    expect(r!.concepts.length).toBeGreaterThanOrEqual(2);
  });

  it("handles 'what version of python and node do i have and are they up to date'", () => {
    const r = routeByConcepts("what version of python and node do i have and are they up to date");
    // "python" and "node" aren't in the concept map — may return null or low confidence
    // This is expected — concept router only knows mapped concepts
    if (r) {
      expect(r.isQuestion).toBe(true);
    }
  });

  it("handles 'can you check the bandwidth usage and see if anyone is doing something weird on the network'", () => {
    const r = routeByConcepts("can you check the bandwidth usage and see if anyone is doing something weird on the network");
    expect(r).not.toBeNull();
    expect(r!.intent.includes("network") || r!.intent.includes("bandwidth")).toBe(true);
  });

  it("handles 'i think somebody is trying to hack into my server can you check the firewall and show recent connections'", () => {
    const r = routeByConcepts("i think somebody is trying to hack into my server can you check the firewall and show recent connections");
    expect(r).not.toBeNull();
    expect(r!.concepts.length).toBeGreaterThanOrEqual(1);
    expect(r!.intent.includes("firewall") || r!.intent.includes("network") || r!.intent.includes("connection")).toBe(true);
  });

  it("handles 'whats the hostname of this machine and what timezone are we in'", () => {
    const r = routeByConcepts("whats the hostname of this machine and what timezone are we in");
    expect(r).not.toBeNull();
    expect(["system.hostname", "system.timezone"]).toContain(r!.intent);
  });

  it("handles 'make me a picture of a golden retriever puppy playing in autumn leaves and open it when done'", () => {
    const r = routeByConcepts("make me a picture of a golden retriever puppy playing in autumn leaves and open it when done");
    expect(r).not.toBeNull();
    expect(r!.intent).toContain("ai.");
  });

  it("handles 'find all the zip files and tar archives on this system they are taking up too much space'", () => {
    const r = routeByConcepts("find all the zip files and tar archives on this system they are taking up too much space");
    expect(r).not.toBeNull();
    expect(r!.concepts.length).toBeGreaterThanOrEqual(1);
  });

  // ── Edge cases ──

  it("handles single word 'memory'", () => {
    const r = routeByConcepts("memory");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("server.check_memory");
  });

  it("handles single word 'docker'", () => {
    const r = routeByConcepts("docker");
    expect(r).not.toBeNull();
    expect(r!.intent).toContain("docker");
  });

  it("handles empty string", () => {
    const r = routeByConcepts("");
    expect(r).toBeNull();
  });

  it("handles just stop words", () => {
    const r = routeByConcepts("the a an is are was were");
    expect(r).toBeNull();
  });
});
