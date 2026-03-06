import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "../src/analysis/analyzeProject";

describe("webpack cross-file registry", () => {
  it("resolves webpack module exports across files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "endpointfinder-wp-"));

    try {
      await writeFile(
        path.join(tempDir, "chunk-a.js"),
        `(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[100],{7252:function(e,t,o){o.d(t,{Z:function(){return r}});function r(){return {mdeEndpoint:'https://x.test/'}}}}]);`,
        "utf8",
      );

      await writeFile(
        path.join(tempDir, "chunk-b.js"),
        `(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[101],{7685:function(e,t,n){var r=n(7252);async function d(){let {mdeEndpoint:o}=(0,r.Z)();await fetch(''.concat(o,'api/auth/login'),{method:'POST'})}d();}}]);`,
        "utf8",
      );

      const result = await analyzeProject(tempDir, {
        includeUnresolved: true,
      });

      const finding = result.findings.find((item) => item.sink === "fetch");
      expect(finding).toBeDefined();
      expect(finding?.url).toBe("https://x.test/api/auth/login");
      expect(finding?.method).toBe("POST");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
