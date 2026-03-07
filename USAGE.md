# EndpointFinder Usage Guide

This guide explains how to install, configure, and use EndpointFinder in real projects.

## 1) Overview

EndpointFinder is a static JavaScript/TypeScript analyzer for endpoint discovery.

It parses code into an AST and detects request sinks such as:

- `fetch(...)`
- `new Request(...)`
- `XMLHttpRequest.open(...)`
- `axios(...)` and `axios.get/post/put/delete/patch(...)`
- `new WebSocket(...)`
- `new EventSource(...)`
- `navigator.sendBeacon(...)`

It also resolves practical indirect patterns:

- aliases (`const f = fetch; f("/api")`)
- alias chains
- wrapper forwarding (`(...args) => fetch(...args)`)
- parameter forwarding (`use(fetch)`)
- extracted/bound methods (`const get = axios.get`, `.bind(...)`)
- instance methods from `axios.create({ baseURL })`

Typical use cases:

- reverse engineering SPAs and chunk bundles
- security auditing and API surface discovery
- endpoint inventory for testing and tooling import
- static code analysis in CI or local review
- webpack/Next-style bundle endpoint extraction

---

## 2) Installation

### Requirements

- Recommended runtime: **Bun 1.3+**
- Also supported for built CLI: **Node.js 18+**

### Install dependencies

Using Bun (recommended):

```bash
bun install
```

Using npm:

```bash
npm install
```

### Build

```bash
bun run build
```

### Run locally

Without building (dev entry):

```bash
bun run src/cli/index.ts ./src
```

Built CLI:

```bash
node dist/cli/index.js ./src
```

If installed as a package exposing the bin, the command name is:

```bash
analyze-endpoints ./src
```

---

## 3) CLI Usage

Basic form:

```bash
analyze-endpoints <path-or-url> [options]
```

Examples:

```bash
analyze-endpoints ./src
analyze-endpoints ./dist
analyze-endpoints ./chunk.js
analyze-endpoints ./dist --json
analyze-endpoints ./dist --export swagger
analyze-endpoints https://example.com --site-mode direct
```

### Options

| Flag | Description |
|---|---|
| `--json` | Emit full JSON report |
| `--export <swagger\|postman\|burp>` | Export endpoints for OpenAPI/Postman/Burp |
| `--config <file>` | Load custom sink config JSON |
| `--unresolved` | Include unresolved/partial candidates |
| `--site-mode <direct\|clone>` | URL mode: in-memory analysis or local snapshot clone |
| `--clone-dir <dir>` | Clone output directory (with `--site-mode clone`) |
| `--max-remote-files <n>` | Limit remotely fetched script files |
| `--timeout-ms <n>` | Per-request timeout for URL mode |
| `--same-origin-only` | Restrict crawl to entry origin (default behavior) |
| `--cross-origin` | Allow cross-origin script crawling |
| `--concurrency <n>` | Bounded parallelism for analysis/fetch/index work |
| `--profile` | Print timing/profile report (stderr) |
| `--help`, `-h` | Show help |

Notes:

- `--json` and `--export` are mutually exclusive.
- There is currently **no** dedicated `--output` flag. Save output with shell redirection:

```bash
analyze-endpoints ./dist --json > findings.json
analyze-endpoints ./dist --export postman > endpoints.postman.json
```

---

## 4) Output Format

### Top-level report shape

`--json` outputs `AnalyzeProjectResult`:

```json
{
  "target": "/abs/path/or/url",
  "filesAnalyzed": 12,
  "findings": [],
  "errors": [],
  "sourceMode": "local",
  "clonedTo": "/optional/clone/path",
  "timings": {
    "totalMs": 1234.56,
    "parseMs": 120.5,
    "analysisMs": 900.2,
    "resolverMs": 750.1,
    "fileCount": 12,
    "fileTimings": []
  }
}
```

### Finding fields

Each finding includes:

- `file`, `line`, `column`: source location
- `sink`: matched sink name (for example `fetch`, `axios.get`)
- `method`: inferred HTTP method if known
- `url`: exact resolved URL when fully known
- `urlTemplate`: template when dynamic/partial
- `confidence`: `high` / `medium` / `low`
- `resolutionTrace`: compact resolution path
- optional `codeSnippet`, `headers`, `body`

Example finding:

```json
{
  "file": "src/api/client.ts",
  "line": 42,
  "column": 15,
  "sink": "fetch",
  "method": "POST",
  "url": null,
  "urlTemplate": "${apiBase}/users/${id}",
  "confidence": "medium",
  "resolutionTrace": [
    "Identifier(url)",
    "TemplateLiteral",
    "Sink(fetch)"
  ]
}
```

How to read URL fields:

- **Exact URL**: `url` is set, `urlTemplate` is `null`
- **Template URL**: `url` is `null`, `urlTemplate` is set
- **Partial/unknown**: may include placeholders (`${...}`) and lower confidence

---

## 5) Supported Sinks

Built-in sinks:

- `fetch`
- `Request` constructor
- `XMLHttpRequest.open`
- `WebSocket` constructor
- `EventSource` constructor
- `navigator.sendBeacon`
- `axios` call form
- `axios.get`
- `axios.post`
- `axios.put`
- `axios.delete`
- `axios.patch`

Additional support:

- `axios.create({ baseURL })` instance methods like `client.get(...)`
- alias/wrapper/forwarding patterns (shallow and practical)
- custom sink definitions from config

---

## 6) Custom Sink Configuration

Create a JSON file:

```json
{
  "sinks": [
    {
      "name": "apiClient.get",
      "type": "method",
      "match": "apiClient.get",
      "urlArg": 0,
      "httpMethod": "GET"
    }
  ]
}
```

Run with:

```bash
analyze-endpoints ./dist --config ./custom-sinks.json
```

Fields:

- `name`: display name in findings
- `type`: `call`, `method`, or `constructor`
- `match`: callee/method pattern to match
- `urlArg`: argument index for URL/target
- `methodArg` (optional): argument index containing HTTP method
- `baseURLArg` (optional): argument index for base URL
- `httpMethod` (optional): fixed method override (normalized to uppercase)

---

## 7) Analysis Model (Conceptual)

EndpointFinder uses a pragmatic static pipeline:

1. Parse JS/TS into Babel AST
2. Build per-file indexes (functions, callsites, assignments, webpack modules)
3. Detect sink calls/constructors
4. Resolve sink arguments through expression and identifier resolvers
5. Follow shallow wrappers, alias chains, and parameter forwarding
6. Reconstruct exact URLs or templates
7. Emit findings with confidence and trace

It favors useful, scalable static heuristics over deep symbolic execution.

---

## 8) Limitations

Static analysis cannot fully resolve everything. Common limits:

- runtime-only values (user input, storage, server config)
- environment-dependent constants loaded at runtime
- dynamic code (`eval`, generated scripts)
- WASM/native string construction
- heavily obfuscated patterns beyond shallow propagation

When exact resolution is not possible, the analyzer returns `urlTemplate` and lower confidence.

---

## 9) Performance and Large Bundles

Use these options on large projects/chunks:

```bash
analyze-endpoints ./dist --concurrency 8 --profile
analyze-endpoints https://example.com --site-mode direct --max-remote-files 40 --timeout-ms 5000 --profile
```

Tips:

- Start with default same-origin crawl (faster, less noisy).
- Use `--cross-origin` only when needed.
- Cap fetch scope using `--max-remote-files`.
- Use `--profile` to identify slow files and phases.

`--profile` output includes:

- total time
- parse / analysis / resolver time
- resolver cache hit rate
- optional source collection / clone / report time
- slowest files table

The profile block is printed to **stderr** so it does not corrupt `--json` or export payloads on stdout.

Note: there is no separate `--timings` flag; timing output is provided by `--profile`.

---

## 10) Practical Examples

### Example 1 — Simple `fetch`

Input:

```js
fetch("https://api.example.com/users");
```

Result (simplified):

```json
{
  "sink": "fetch",
  "method": "GET",
  "url": "https://api.example.com/users",
  "confidence": "high"
}
```

### Example 2 — Base URL + path

Input:

```js
const base = "https://api.example.com";
fetch(base + "/auth/login", { method: "POST" });
```

Result (simplified):

```json
{
  "sink": "fetch",
  "method": "POST",
  "url": "https://api.example.com/auth/login",
  "confidence": "high"
}
```

### Example 3 — Wrapper function

Input:

```js
function request(url) {
  return fetch(url);
}
request("/v1/me");
```

Result (simplified):

```json
{
  "sink": "fetch",
  "url": "/v1/me",
  "confidence": "high"
}
```

### Example 4 — Axios client instance

Input:

```js
const client = axios.create({ baseURL: "https://api.example.com" });
client.get("/projects");
```

Result (simplified):

```json
{
  "sink": "axios.get",
  "method": "GET",
  "url": "https://api.example.com/projects",
  "confidence": "high"
}
```

### Example 5 — Alias chain

Input:

```js
const a = fetch;
const b = a;
b("/users");
```

Result (simplified):

```json
{
  "sink": "fetch",
  "url": "/users",
  "confidence": "high",
  "resolutionTrace": ["Identifier(b)", "IndirectSink(fetch)", "Sink(fetch)"]
}
```

---

## 11) Troubleshooting

- No output for a long time on URL targets:
  - keep same-origin mode (default)
  - lower `--max-remote-files`
  - set `--timeout-ms`
  - run with `--profile` for phase visibility
- Need machine-readable output:
  - use `--json` and redirect to a file
- Need specific app SDK methods:
  - define custom sinks with `--config`
