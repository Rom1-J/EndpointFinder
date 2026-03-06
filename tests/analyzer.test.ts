import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/analysis/analyzeFile";
import {
  mergeSinkDefinitions,
  type SinkDefinition,
} from "../src/sinks/sinkConfig";

function run(code: string, sinkDefinitions?: SinkDefinition[]) {
  return analyzeSource(code, "sample.js", {
    includeUnresolved: true,
    sinkDefinitions,
  }).findings;
}

function bySink(findings: ReturnType<typeof run>, sinkName: string) {
  const finding = findings.find((item) => item.sink === sinkName);
  expect(finding).toBeDefined();
  return finding!;
}

describe("endpoint analyzer", () => {
  it("detects direct fetch literal", () => {
    const findings = run('fetch("https://api.example.com/users")');
    const finding = bySink(findings, "fetch");
    expect(finding.url).toBe("https://api.example.com/users");
    expect(finding.confidence).toBe("high");
  });

  it("resolves fetch with const concatenation", () => {
    const findings = run(
      'const BASE = "https://api.example.com"; fetch(BASE + "/users")',
    );
    const finding = bySink(findings, "fetch");
    expect(finding.url).toBe("https://api.example.com/users");
  });

  it("resolves template literals with dynamic segments", () => {
    const findings = run(
      "const base = 'https://api.example.com'; fetch(`${base}/users/${id}`)",
    );
    const finding = bySink(findings, "fetch");
    expect(finding.url).toBeNull();
    expect(finding.urlTemplate).toContain("https://api.example.com/users/");
    expect(["medium", "low"]).toContain(finding.confidence);
  });

  it("detects XMLHttpRequest.open", () => {
    const findings = run(
      "const xhr = new XMLHttpRequest(); xhr.open('POST', 'https://x.test/u')",
    );
    const finding = bySink(findings, "XMLHttpRequest.open");
    expect(finding.method).toBe("POST");
    expect(finding.url).toBe("https://x.test/u");
  });

  it("detects XMLHttpRequest.prototype.open", () => {
    const findings = run(
      "XMLHttpRequest.prototype.open('GET', 'https://x.test/proto')",
    );
    const finding = bySink(findings, "XMLHttpRequest.open");
    expect(finding.method).toBe("GET");
    expect(finding.url).toBe("https://x.test/proto");
  });

  it("detects axios direct call", () => {
    const findings = run("axios('https://x.test/v1/me')");
    const finding = bySink(findings, "axios");
    expect(finding.url).toBe("https://x.test/v1/me");
    expect(finding.method).toBe("GET");
  });

  it("resolves axios instance baseURL", () => {
    const findings = run(
      "const client = axios.create({ baseURL: 'https://api.example.com' }); client.get('/users')",
    );
    const finding = bySink(findings, "axios.get");
    expect(finding.url).toBe("https://api.example.com/users");
  });

  it("detects WebSocket constructor", () => {
    const findings = run("new WebSocket('wss://socket.example.com/ws')");
    const finding = bySink(findings, "WebSocket");
    expect(finding.url).toBe("wss://socket.example.com/ws");
  });

  it("resolves wrapper function endpoint", () => {
    const findings = run(
      "const BASE = 'https://api.example.com'; function api(path) { return fetch(BASE + path); } api('/users')",
    );
    const finding = bySink(findings, "fetch");
    expect(finding.url).toBe("https://api.example.com/users");
  });

  it("extracts fetch headers and body metadata", () => {
    const findings = run(
      "fetch('https://x.test/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({u:1}) })",
    );
    const finding = bySink(findings, "fetch");
    expect(finding.method).toBe("POST");
    expect(finding.headers?.some((header) => header.name === "Content-Type")).toBe(
      true,
    );
    expect(finding.body?.value ?? finding.body?.valueTemplate).toContain("\"u\"");
  });

  it("extracts axios headers and body metadata", () => {
    const findings = run(
      "axios.post('https://x.test/u', JSON.stringify({id: 7}), { headers: { Authorization: token } })",
    );
    const finding = bySink(findings, "axios.post");
    expect(finding.url).toBe("https://x.test/u");
    expect(finding.headers?.some((header) => header.name === "Authorization")).toBe(
      true,
    );
    expect(finding.body?.value ?? finding.body?.valueTemplate).toContain("\"id\"");
  });

  it("resolves FormData append fields in request body", () => {
    const findings = run(
      "const fd = new FormData(); fd.append('email', userEmail); fd.append('otp', code); fetch('https://x.test/login', { method: 'POST', body: fd })",
    );
    const finding = bySink(findings, "fetch");
    expect(finding.body).toBeDefined();
    const bodyText = finding.body?.value ?? finding.body?.valueTemplate ?? "";
    expect(bodyText).toContain("FormData{");
    expect(bodyText).toContain("email=");
    expect(bodyText).toContain("otp=");
  });

  it("resolves one-level parameter propagation", () => {
    const findings = run(
      "function req(url) { return fetch(url); } req('https://x.test/u')",
    );
    const finding = bySink(findings, "fetch");
    expect(finding.url).toBe("https://x.test/u");
  });

  it("resolves object property based base URL", () => {
    const findings = run(
      "const cfg = { api: 'https://x.test' }; axios.get(cfg.api + '/v1/me')",
    );
    const finding = bySink(findings, "axios.get");
    expect(finding.url).toBe("https://x.test/v1/me");
  });

  it("handles minified-style code", () => {
    const findings = run(
      "const a='https://m.test';function b(c){return fetch(a+c)}b('/q')",
    );
    const finding = bySink(findings, "fetch");
    expect(finding.url).toBe("https://m.test/q");
  });

  it("reports partially unresolved dynamic segments", () => {
    const findings = run(
      "const base='https://a.test';fetch(base + '/users/' + id)",
    );
    const finding = bySink(findings, "fetch");
    expect(finding.url).toBeNull();
    expect(finding.urlTemplate).toContain("https://a.test/users/");
  });

  it("resolves transpiled string concat call pattern", () => {
    const findings = run(
      "const o='https://x.test/'; fetch(''.concat(o,'api/auth/login'))",
    );
    const finding = bySink(findings, "fetch");
    expect(finding.url).toBe("https://x.test/api/auth/login");
  });

  it("resolves object destructuring then concat", () => {
    const findings = run(
      "const cfg={mdeEndpoint:'https://x.test/'}; const {mdeEndpoint:o}=cfg; fetch(''.concat(o,'api/auth/login'))",
    );
    const finding = bySink(findings, "fetch");
    expect(finding.url).toBe("https://x.test/api/auth/login");
  });

  it("resolves webpack-style require export function for endpoint base", () => {
    const findings = run(`
      (self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[5343],{
        7252:function(e,t,o){
          o.d(t,{Z:function(){return r}});
          function r(){ return { mdeEndpoint: 'https://x.test/' }; }
        },
        7685:function(e,t,n){
          var r=n(7252);
          async function d(){
            let {mdeEndpoint:o}=(0,r.Z)();
            await fetch(''.concat(o,'api/auth/login'),{method:'POST'});
          }
          d();
        }
      }]);
    `);
    const finding = bySink(findings, "fetch");
    expect(finding.url).toBe("https://x.test/api/auth/login");
    expect(finding.method).toBe("POST");
  });

  it("supports configurable custom sinks", () => {
    const customSinks: SinkDefinition[] = [
      {
        name: "apiClient.get",
        type: "method",
        match: "apiClient.get",
        urlArg: 0,
        httpMethod: "GET",
      },
    ];

    const findings = run(
      "apiClient.get('https://custom.test/x')",
      mergeSinkDefinitions(customSinks),
    );
    const finding = bySink(findings, "apiClient.get");
    expect(finding.url).toBe("https://custom.test/x");
    expect(finding.method).toBe("GET");
  });

  it("supports custom sink baseURLArg semantics", () => {
    const customSinks: SinkDefinition[] = [
      {
        name: "http.get",
        type: "method",
        match: "http.get",
        urlArg: 0,
        baseURLArg: 1,
        httpMethod: "GET",
      },
    ];

    const findings = run(
      "http.get('/users', 'https://api.custom.test')",
      mergeSinkDefinitions(customSinks),
    );

    const finding = bySink(findings, "http.get");
    expect(finding.url).toBe("https://api.custom.test/users");
    expect(finding.method).toBe("GET");
  });
});
