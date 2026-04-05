import { describe, it, expect } from "vitest";

// Test the stats parsing logic without calling getSystemStats() directly
// (which invokes nvidia-smi and PowerShell that can cause system instability)

describe("System Stats Parsing Logic", () => {
  function parseStatOutput(output: string) {
    const parts = output.trim().split("|");
    const cpu = parseInt(parts[0]) || 0;
    const totalKB = parseInt(parts[1]) || 0;
    const freeKB = parseInt(parts[2]) || 0;
    return {
      cpu,
      ram: {
        total: Math.round(totalKB / 1024 / 1024 * 10) / 10,
        used: Math.round((totalKB - freeKB) / 1024 / 1024 * 10) / 10,
        pct: totalKB > 0 ? Math.round((totalKB - freeKB) / totalKB * 100) : 0,
      },
    };
  }

  it("parses CPU|RAM pipe-separated output", () => {
    const stats = parseStatOutput("38|67031284|22544572");
    expect(stats.cpu).toBe(38);
    expect(stats.ram.total).toBeCloseTo(63.9, 0);
    expect(stats.ram.used).toBeGreaterThan(0);
    expect(stats.ram.pct).toBeGreaterThan(0);
    expect(stats.ram.pct).toBeLessThan(100);
  });

  it("handles zero values", () => {
    const stats = parseStatOutput("0|0|0");
    expect(stats.cpu).toBe(0);
    expect(stats.ram.total).toBe(0);
    expect(stats.ram.pct).toBe(0);
  });

  it("handles 100% CPU", () => {
    const stats = parseStatOutput("100|8388608|0");
    expect(stats.cpu).toBe(100);
    expect(stats.ram.pct).toBe(100);
  });

  function parseGpuOutput(output: string) {
    const parts = output.split(",").map(s => s.trim());
    return {
      usage: parseInt(parts[0]) || 0,
      memUsage: parseInt(parts[1]) || 0,
      memUsed: parseInt(parts[2]) || 0,
      memTotal: parseInt(parts[3]) || 0,
      temp: parseInt(parts[4]) || 0,
      name: parts[5] || "GPU",
    };
  }

  it("parses nvidia-smi CSV output", () => {
    const gpu = parseGpuOutput("30, 9, 5247, 6144, 59, NVIDIA GeForce GTX 1060 6GB");
    expect(gpu.usage).toBe(30);
    expect(gpu.memUsed).toBe(5247);
    expect(gpu.memTotal).toBe(6144);
    expect(gpu.temp).toBe(59);
    expect(gpu.name).toContain("GTX 1060");
  });

  it("handles missing GPU", () => {
    const gpu = parseGpuOutput("");
    expect(gpu.usage).toBe(0);
    expect(gpu.name).toBe("GPU");
  });
});
