# Endpoint Static Analyzer (AST-Based)

This project is a practical static JavaScript/TypeScript analyzer for endpoint discovery in front-end apps, including SPA bundles and minified chunk files.

It is **not** a regex URL grep. It parses source into an AST and performs sink detection plus lightweight value/dataflow resolution.

## What It Does

- Detects network sinks such as:
  - `fetch(url, init)`
  - `new Request(url, init)`
  - `XMLHttpRequest.open(method, url, ...)`
  - `new WebSocket(url)`
  - `new EventSource(url)`
  - `navigator.sendBeacon(url, data)`
  - `axios(config)` / `axios(url)`
  - `axios.get/post/put/delete/patch(...)`
  - `axios.create({ baseURL })` instances and derived calls (`client.get(...)`)
- Supports configurable custom sinks through JSON config
- Resolves URL expressions with a structured value model:
  - literals
  - templates
  - concatenation
  - transpiled concat calls (e.g. `"".concat(base, "api/auth/login")`)
  - identifiers/bindings
  - object destructuring bindings (`const { baseURL: b } = cfg`)
  - object property access
  - conditional unions
  - `new URL(...)`
  - `URLSearchParams` (lightweight support)
- Includes webpack/Next chunk helpers:
  - resolves local webpack module exports (`n(1234)` patterns)
  - project-wide cross-file webpack export registry for chunk-to-chunk resolution
- Performs shallow interprocedural parameter resolution via call sites
- Emits findings with source location, confidence, and resolution trace
- Continues analysis even if some files fail to parse

## Architecture

```text
src/
  parser/
    parseFile.ts
  sinks/
    builtinSinks.ts
    matchSink.ts
    sinkConfig.ts
  resolver/
    valueModel.ts
    resolveExpression.ts
    resolveIdentifier.ts
    resolveCall.ts
    renderValue.ts
  analysis/
    analyzeFile.ts
    analyzeProject.ts
    analyzeUrl.ts
  report/
    jsonReporter.ts
    textReporter.ts
  cli/
    index.ts
  web/
    siteSourceCollector.ts
```

Core phases:

1. Parse source files to AST (`@babel/parser`)
2. Build lightweight function call-site index
3. Match sink calls/constructors
4. Resolve URL arguments backward through expressions and bindings
5. Perform shallow interprocedural parameter propagation
6. Render exact URLs or URL templates
7. Emit structured findings and CLI summary

## Installation

```bash
bun install
```

## Usage

### CLI

```bash
bun run build
bun run dist/cli/index.js ./dist
bun run dist/cli/index.js ./chunk.js --json
bun run dist/cli/index.js ./dist --export swagger
bun run dist/cli/index.js ./dist --export postman
bun run dist/cli/index.js ./dist --export burp
bun run dist/cli/index.js ./src --config ./examples/custom-sinks.json
bun run dist/cli/index.js https://example.com --site-mode direct
bun run dist/cli/index.js https://example.com --site-mode clone --clone-dir ./site-snapshot
```

For development without building first:

```bash
bun run dev -- ./dist
```

CLI options:

- `--json` output full JSON report
- `--export <swagger|postman|burp>` export findings as OpenAPI (Swagger), Postman collection, or Burp Repeater request blocks
- `--config <file>` load custom sink definitions
- `--unresolved` include unresolved sink candidates
- `--site-mode <direct|clone>` URL mode (`direct` analyzes fetched sources in-memory; `clone` saves a local snapshot first)
- `--clone-dir <dir>` output directory for cloned site sources
- `--max-remote-files <n>` cap the number of remotely fetched script files
- `--timeout-ms <n>` per-request timeout for remote source fetching
- `--same-origin-only` restrict remote crawling to the entry URL origin

### Analyze a URL

You can target a live website URL instead of a local path.

- `direct` mode:
  - fetches entry HTML and script sources
  - discovers additional chunk/module JS references from parsed AST
  - analyzes sources directly without writing files
- `clone` mode:
  - performs the same discovery
  - writes fetched HTML/JS sources to `--clone-dir`
  - analyzes the cloned local copies

### Export to API Tools

You can export the discovered endpoints in formats that can be imported/used by common tooling:

- Swagger / OpenAPI JSON:

```bash
bun run dist/cli/index.js ./dist --export swagger > endpoints.openapi.json
```

- Postman Collection v2.1 JSON:

```bash
bun run dist/cli/index.js ./dist --export postman > endpoints.postman.json
```

- Burp Repeater raw request blocks:

```bash
bun run dist/cli/index.js ./dist --export burp > endpoints.burp.txt
```

### Custom Sink Config

Example: `examples/custom-sinks.json`

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

`type` can be `call`, `method`, or `constructor`.

Optional fields:

- `methodArg`: index of argument carrying HTTP method
- `baseURLArg`: index of argument carrying a base URL to join with `urlArg`
- `httpMethod`: fixed method when known

## Output

Each finding includes:

- `file`
- `line`
- `column`
- `sink`
- `method` (if known)
- `url` (exact when fully resolved)
- `urlTemplate` (partial/dynamic)
- `confidence` (`high` / `medium` / `low`)
- `resolutionTrace`
- `codeSnippet`

## Confidence Model

- **high**: fully resolved literal URL
- **medium**: resolved template with dynamic placeholders and low uncertainty
- **low**: partial or unknown-heavy result

Low-confidence findings are still reported.

## Tests

Run:

```bash
bun run test
```

Current suite covers:

1. Direct fetch literal
2. Fetch with const + concatenation
3. Fetch with template literals
4. `XMLHttpRequest.open`
5. Axios direct call
6. Axios instance with `baseURL`
7. WebSocket constructor
8. Simple wrapper function
9. One-level parameter propagation
10. Object property-based base URL
11. Minified-style sample
12. Partially unresolved dynamic segment
13. Custom configured sink

## Notes and Limits (MVP)

- Designed for practical reverse engineering and auditing value, not full theorem-prover precision
- Does not attempt to fully model `eval`, generated code, source maps, or deep framework internals
- Uses shallow interprocedural resolution and conservative fallbacks
