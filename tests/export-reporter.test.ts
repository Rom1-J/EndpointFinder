import { describe, expect, it } from "vitest";
import { toExportReport } from "../src/report/exportReporter";
import type { AnalyzeProjectResult } from "../src/types";

const sampleResult: AnalyzeProjectResult = {
  target: "https://api.example.com",
  filesAnalyzed: 1,
  findings: [
    {
      file: "sample.js",
      line: 10,
      column: 2,
      sink: "fetch",
      method: "POST",
      url: "https://api.example.com/auth/login",
      urlTemplate: null,
      confidence: "high",
      resolutionTrace: ["StringLiteral", "Sink(fetch)"],
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
        valueTemplate: "{ \"email\": ${email}, \"otp\": ${otp} }",
        confidence: "medium",
      },
    },
  ],
  errors: [],
  sourceMode: "local",
};

describe("export reporter", () => {
  it("exports swagger-compatible openapi json", () => {
    const output = toExportReport(sampleResult, "swagger");
    const parsed = JSON.parse(output) as {
      openapi: string;
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };

    expect(parsed.openapi).toBe("3.0.3");
    expect(parsed.paths["/auth/login"]).toBeDefined();
    expect(parsed.paths["/auth/login"].post).toBeDefined();
    expect(parsed.paths["/auth/login"].post.requestBody).toBeDefined();
  });

  it("exports postman collection json", () => {
    const output = toExportReport(sampleResult, "postman");
    const parsed = JSON.parse(output) as {
      info: { schema: string };
      item: Array<{ request: { method: string; body?: { raw?: string } } }>;
    };

    expect(parsed.info.schema).toContain("collection/v2.1.0");
    expect(parsed.item.length).toBe(1);
    expect(parsed.item[0].request.method).toBe("POST");
    expect(parsed.item[0].request.body?.raw).toContain("{{email}}");
  });

  it("exports burp repeater text requests", () => {
    const output = toExportReport(sampleResult, "burp");
    expect(output).toContain("POST /auth/login HTTP/1.1");
    expect(output).toContain("Host: api.example.com");
    expect(output).toContain("Content-Type: application/json");
  });
});
