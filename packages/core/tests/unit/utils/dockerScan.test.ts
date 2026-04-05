import { describe, it, expect } from "vitest";

// Test the docker system df parsing logic that lives in diskCleanup.ts.
// We extract the parsing pattern and test it directly since scanDocker
// depends on a live Docker daemon.

describe("docker system df output parsing", () => {
  const SAMPLE_DOCKER_DF = `TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          12        5         3.842GB   2.5GB (65%)
Containers      8         2         1.234GB   956.7MB (77%)
Local Volumes   15        3         5.678GB   4.2GB (73%)
Build Cache     45        0         1.89GB    1.89GB (100%)`;

  function parseDockerDfComponent(output: string, component: string): number {
    for (const line of output.split("\n")) {
      if (line.startsWith(component) || line.includes(component)) {
        const parts = line.split(/\s{2,}/);
        const reclaimable = parts[parts.length - 1];
        const sizeMatch = reclaimable.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
        if (sizeMatch) {
          const num = parseFloat(sizeMatch[1]);
          const unit = sizeMatch[2].toUpperCase();
          if (unit === "TB") return num * 1024;
          if (unit === "GB") return num;
          if (unit === "MB") return num / 1024;
          if (unit === "KB") return num / (1024 * 1024);
          return num / 1073741824;
        }
      }
    }
    return 0;
  }

  it("parses Images reclaimable size", () => {
    const size = parseDockerDfComponent(SAMPLE_DOCKER_DF, "Images");
    expect(size).toBeCloseTo(2.5, 1);
  });

  it("parses Containers reclaimable size in MB", () => {
    const size = parseDockerDfComponent(SAMPLE_DOCKER_DF, "Containers");
    expect(size).toBeCloseTo(956.7 / 1024, 1);
  });

  it("parses Local Volumes reclaimable size", () => {
    const size = parseDockerDfComponent(SAMPLE_DOCKER_DF, "Local Volumes");
    expect(size).toBeCloseTo(4.2, 1);
  });

  it("parses Build Cache reclaimable size", () => {
    const size = parseDockerDfComponent(SAMPLE_DOCKER_DF, "Build Cache");
    expect(size).toBeCloseTo(1.89, 1);
  });

  it("returns 0 for unknown component", () => {
    const size = parseDockerDfComponent(SAMPLE_DOCKER_DF, "Networks");
    expect(size).toBe(0);
  });
});

describe("docker image size parsing", () => {
  function parseImageSizes(output: string): number {
    let total = 0;
    for (const line of output.trim().split("\n").filter(Boolean)) {
      const match = line.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
      if (match) {
        const num = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        if (unit === "TB") total += num * 1024;
        else if (unit === "GB") total += num;
        else if (unit === "MB") total += num / 1024;
        else if (unit === "KB") total += num / (1024 * 1024);
      }
    }
    return Math.round(total * 100) / 100;
  }

  it("sums multiple image sizes", () => {
    const output = "1.2GB\n500MB\n250MB\n100MB";
    const total = parseImageSizes(output);
    expect(total).toBeCloseTo(2.03, 1);
  });

  it("handles mixed units", () => {
    const output = "2GB\n512MB";
    const total = parseImageSizes(output);
    expect(total).toBeCloseTo(2.5, 1);
  });

  it("returns 0 for empty output", () => {
    expect(parseImageSizes("")).toBe(0);
  });
});
