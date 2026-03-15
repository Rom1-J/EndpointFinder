import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/analysis/analyzeFile";

function run(code: string) {
  return analyzeSource(code, "member-http-sample.js", {
    includeUnresolved: true,
  }).findings;
}

function bySink(findings: ReturnType<typeof run>, sinkName: string) {
  const finding = findings.find((item) => item.sink === sinkName);
  expect(finding).toBeDefined();
  return finding!;
}

describe("member-based HTTP sink detection", () => {
  it("detects this.http.get('/api/users')", () => {
    const findings = run(
      "class S{constructor(http){this.http=http;} list(){return this.http.get('/api/users')}} new S({}).list();",
    );
    const finding = bySink(findings, "member-http.get");
    expect(finding.method).toBe("GET");
    expect(finding.url).toBe("/api/users");
    expect(finding.confidence).toBe("high");
  });

  it("detects this.http.post with baseUrl template", () => {
    const findings = run(
      "class IdeaService{baseUrl='/api/idea';constructor(http){this.http=http;} generate(id,text){return this.http.post(`${this.baseUrl}/generate`,{client_id:id,problem_text:text});}} new IdeaService({}).generate(1,'x');",
    );
    const finding = bySink(findings, "member-http.post");
    expect(finding.method).toBe("POST");
    expect(finding.urlTemplate ?? finding.url).toContain("/api/idea/generate");
  });

  it("detects this.http.put with id path", () => {
    const findings = run(
      "class S{baseUrl='/api/idea';constructor(http){this.http=http;} update(id,body){return this.http.put(`${this.baseUrl}/${id}`,body);}} new S({}).update(1,{});",
    );
    const finding = bySink(findings, "member-http.put");
    expect(finding.method).toBe("PUT");
    expect(finding.urlTemplate ?? finding.url).toContain("/api/idea/");
  });

  it("detects this.http.patch", () => {
    const findings = run(
      "class S{baseUrl='/api/idea';constructor(http){this.http=http;} patch(ideas){return this.http.patch(`${this.baseUrl}/batch`,{ideas});}} new S({}).patch([]);",
    );
    const finding = bySink(findings, "member-http.patch");
    expect(finding.method).toBe("PATCH");
    expect(finding.url).toBe("/api/idea/batch");
  });

  it("detects this.http.delete", () => {
    const findings = run(
      "class S{baseUrl='/api/idea';constructor(http){this.http=http;} remove(id){return this.http.delete(`${this.baseUrl}/${id}`);}} new S({}).remove(2);",
    );
    const finding = bySink(findings, "member-http.delete");
    expect(finding.method).toBe("DELETE");
    expect(finding.urlTemplate ?? finding.url).toContain("/api/idea/");
  });

  it("resolves class field baseUrl + this.http.get", () => {
    const findings = run(
      "class S{baseUrl='/api/roadmap';constructor(http){this.http=http;} getByClient(id){return this.http.get(`${this.baseUrl}/client/${id}`);}} new S({}).getByClient(1);",
    );
    const finding = bySink(findings, "member-http.get");
    expect(finding.urlTemplate ?? finding.url).toContain("/api/roadmap/client/");
  });

  it("uses constructor assignment this.http = http as confidence signal", () => {
    const findings = run(
      "class S{constructor(http){this.http=http;} call(){return this.http.get('/v1/users');}} new S({}).call();",
    );
    const finding = bySink(findings, "member-http.get");
    expect(finding.confidence).toBe("high");
    expect(finding.detectionReason?.some((reason) => reason.includes("member assignment seen"))).toBe(
      true,
    );
  });

  it("detects member client.get('/users')", () => {
    const findings = run("const client={}; client.get('/users')");
    const finding = bySink(findings, "member-http.get");
    expect(finding.method).toBe("GET");
    expect(finding.url).toBe("/users");
  });

  it("detects request('GET', '/users')", () => {
    const findings = run("service.request('GET', '/users')");
    const finding = bySink(findings, "member-http.request");
    expect(finding.method).toBe("GET");
    expect(finding.url).toBe("/users");
  });

  it("detects request({ method: 'POST', url: '/users' })", () => {
    const findings = run("api.http.request({ method: 'POST', url: '/users' })");
    const finding = bySink(findings, "member-http.request");
    expect(finding.method).toBe("POST");
    expect(finding.url).toBe("/users");
  });

  it("does not mark generic .get() helper as high confidence", () => {
    const findings = run(
      "const cache = { get(k){ return k; } }; const out = cache.get(key);",
    );
    const finding = findings.find((item) => item.sink === "member-http.get");
    if (!finding) {
      expect(finding).toBeUndefined();
      return;
    }
    expect(finding.confidence).not.toBe("high");
  });

  it("detects minified/transpiled class-style service snippet", () => {
    const findings = run(
      "function S(http){this.http=http;this.baseUrl='/api/idea';}S.prototype.getByClient=function(id){return this.http.get(''.concat(this.baseUrl,'/client/').concat(id));};(new S({})).getByClient(10);",
    );
    const finding = bySink(findings, "member-http.get");
    expect(finding.urlTemplate ?? finding.url).toContain("/api/idea/client/");
  });
});
