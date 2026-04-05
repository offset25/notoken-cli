import { describe, it, expect } from "vitest";
import { analyzeLoad, analyzeDisk, analyzeMemory } from "../../../src/utils/analysis.js";

describe("analyzeLoad", () => {
  it("detects healthy load", () => {
    const output = " 15:00:00 up 10 days, load average: 0.5, 0.6, 0.7\n4\n";
    const analysis = analyzeLoad(output);
    expect(analysis).toContain("vCPUs");
    expect(analysis).toContain("4");
    expect(analysis).toContain("OK");
    expect(analysis).toContain("Healthy");
  });

  it("detects overloaded system", () => {
    const output = " 15:00:00 up 10 days, load average: 12.5, 10.0, 8.0\n4\n";
    const analysis = analyzeLoad(output);
    expect(analysis).toContain("CRITICAL");
  });

  it("detects moderate load", () => {
    const output = " 15:00:00 up 10 days, load average: 3.2, 3.0, 2.8\n4\n";
    const analysis = analyzeLoad(output);
    expect(analysis).toContain("80%");
  });

  it("detects rising trend", () => {
    const output = " 15:00:00 up 10 days, load average: 4.0, 2.0, 1.0\n4\n";
    const analysis = analyzeLoad(output);
    expect(analysis).toContain("UP");
  });
});

describe("analyzeDisk", () => {
  const SAMPLE_DF = `Filesystem  Size  Used Avail Use% Mounted on
/dev/sda1   100G   45G   55G  45% /
/dev/sdb1   500G  497G   3G   99% /data
tmpfs       16G     0   16G   0% /tmp`;

  it("flags critical partitions (<5GB free)", () => {
    const analysis = analyzeDisk(SAMPLE_DF);
    expect(analysis).toContain("CRITICAL");
    expect(analysis).toContain("/data");
  });

  it("shows healthy when all ok", () => {
    const healthy = `Filesystem  Size  Used Avail Use% Mounted on
/dev/sda1   100G  30G   70G  30% /`;
    const analysis = analyzeDisk(healthy);
    expect(analysis).toContain("healthy");
  });

  it("finds partition for specific path (<5GB free = CRITICAL)", () => {
    const analysis = analyzeDisk(SAMPLE_DF, "/data");
    expect(analysis).toContain("/data");
    expect(analysis).toContain("CRITICAL");
  });

  it("shows usage bars", () => {
    const analysis = analyzeDisk(SAMPLE_DF);
    expect(analysis).toContain("█");
  });
});

describe("analyzeDisk — Windows format", () => {
  it("parses PowerShell df-compatible output", () => {
    const winOutput = `Filesystem      Size  Used Avail Use% Mounted on
C:              238.5G 235.4G 3.1G 99% C:\\
D:              500G 200G 300G 40% D:\\`;
    const analysis = analyzeDisk(winOutput);
    expect(analysis).toContain("CRITICAL");
    expect(analysis).toContain("C:\\");
  });

  it("resolves 'c drive' alias to C:\\ mount", () => {
    const winOutput = `Filesystem      Size  Used Avail Use% Mounted on
C:              238.5G 235.4G 3.1G 99% C:\\`;
    const analysis = analyzeDisk(winOutput, "c drive");
    expect(analysis).toContain("C:\\");
    expect(analysis).toContain("CRITICAL");
  });

  it("resolves 'd drive' alias", () => {
    const winOutput = `Filesystem      Size  Used Avail Use% Mounted on
D:              500G 200G 300G 40% D:\\`;
    const analysis = analyzeDisk(winOutput, "d drive");
    expect(analysis).toContain("D:\\");
    expect(analysis).toContain("Healthy");
  });

  it("suggests cleanup on critical disk", () => {
    const criticalDf = `Filesystem  Size  Used Avail Use% Mounted on
/dev/sda1   100G   98G    2G  98% /`;
    const analysis = analyzeDisk(criticalDf);
    expect(analysis).toContain("free up space");
  });
});

describe("analyzeMemory", () => {
  it("detects healthy memory", () => {
    const output = `               total        used        free      shared  buff/cache   available
Mem:            32Gi        10Gi        15Gi       100Mi       7Gi        20Gi
Swap:          8.0Gi          0B       8.0Gi`;
    const analysis = analyzeMemory(output);
    expect(analysis).toContain("healthy");
    expect(analysis).toContain("No swap usage");
  });

  it("detects high memory usage", () => {
    const output = `               total        used        free      shared  buff/cache   available
Mem:            32Gi        30Gi       0.5Gi       100Mi       1.5Gi       1.5Gi
Swap:          8.0Gi       6.0Gi       2.0Gi`;
    const analysis = analyzeMemory(output);
    expect(analysis).toContain("HIGH");
    expect(analysis).toContain("Swap");
  });
});
