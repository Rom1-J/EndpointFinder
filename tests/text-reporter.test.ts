import { describe, expect, it } from "vitest";
import { toTextReport } from "../src/report/textReporter";
import type { AnalyzeProjectResult } from "../src/types";

describe("text reporter", () => {
  it("groups findings by file with bat-style headings", () => {
    const result: AnalyzeProjectResult = {
      target: "/tmp/project",
      filesAnalyzed: 2,
      findings: [
        {
          file: "/tmp/project/a.js",
          line: 10,
          column: 5,
          sink: "fetch",
          method: "GET",
          url: "https://a.test/users",
          urlTemplate: null,
          confidence: "high",
          resolutionTrace: ["StringLiteral", "Sink(fetch)"],
          codeSnippet: "fetch('https://a.test/users')",
          headers: [
            {
              name: "Content-Type",
              value: "application/json",
              valueTemplate: null,
              confidence: "high",
            },
          ],
          body: {
            value: null,
            valueTemplate: "${call:JSON.stringify}",
            confidence: "low",
          },
        },
        {
          file: "/tmp/project/b.js",
          line: 2,
          column: 1,
          sink: "axios.get",
          method: "GET",
          url: null,
          urlTemplate: "https://b.test/${id}",
          confidence: "medium",
          resolutionTrace: ["TemplateLiteral", "Sink(axios.get)"],
          codeSnippet: "axios.get(`${base}/${id}`)",
        },
      ],
      errors: [
        {
          file: "/tmp/project/b.js",
          message: "Parse warning",
        },
      ],
      sourceMode: "local",
    };

    const report = toTextReport(result, {
      color: false,
      cwd: "/tmp/project",
    });

    expect(report).toContain("Endpoint Analysis");
    expect(report).toContain("==> a.js (1 endpoint) <==");
    expect(report).toContain("Headers:");
    expect(report).toContain("Body:");
    expect(report).toContain("==> b.js (1 endpoint) <==");
    expect(report).toContain("Warnings (1)");
    expect(report).toContain("==> b.js <==");
  });

  it("summarizes long traces with centered ellipsis", () => {
    const result: AnalyzeProjectResult = {
      target: "/tmp/project",
      filesAnalyzed: 1,
      findings: [
        {
          file: "/tmp/project/a.js",
          line: 1,
          column: 1,
          sink: "fetch",
          method: "GET",
          url: "https://a.test",
          urlTemplate: null,
          confidence: "high",
          resolutionTrace: ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
          codeSnippet: "fetch('https://a.test')",
        },
      ],
      errors: [],
      sourceMode: "local",
    };

    const report = toTextReport(result, {
      color: false,
      cwd: "/tmp/project",
      maxTraceSteps: 6,
    });

    expect(report).toContain("Trace: A -> B -> C -> ... -> H -> I");
  });
});
