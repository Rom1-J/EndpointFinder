import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "../src/analysis/analyzeProject";
import { analyzeSource } from "../src/analysis/analyzeFile";
import { toProfileReport } from "../src/report/profileReporter";

describe("profiling", () => {
  it("emits file timing from analyzeSource", () => {
    const result = analyzeSource("fetch('https://x.test/u')", "sample.js", {
      includeUnresolved: true,
      profile: true,
    });

    expect(result.timing).toBeDefined();
    expect(result.timing?.file).toBe("sample.js");
    expect(result.timing?.parseMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(result.timing?.analysisMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(result.timing?.resolverMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(result.timing?.resolverCalls ?? 0).toBeGreaterThan(0);
  });

  it("aggregates project timings and formats profile report", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "endpointfinder-profile-"));

    try {
      await writeFile(
        path.join(tempDir, "api.js"),
        "fetch('https://api.example.test/v1/users')",
        "utf8",
      );

      const result = await analyzeProject(tempDir, {
        includeUnresolved: true,
        profile: true,
      });

      expect(result.timings).toBeDefined();
      expect(result.timings?.fileCount).toBe(1);
      expect(result.timings?.fileTimings.length).toBe(1);

      const report = toProfileReport(result);
      expect(report).toContain("Profile Timings");
      expect(report).toContain("Slowest Files");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
