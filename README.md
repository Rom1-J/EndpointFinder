# EndpointFinder

EndpointFinder is an AST-based static analyzer for JavaScript/TypeScript endpoint discovery.

It is designed for practical API extraction from source code and bundles (including minified SPA chunks), with shallow alias/wrapper resolution and structured findings.

## Features

- Detects common network sinks: `fetch`, `Request`, `XMLHttpRequest.open`, `axios*`, `WebSocket`, `EventSource`, `sendBeacon`
- Resolves indirect calls (aliases, wrappers, parameter forwarding, extracted/bound methods)
- Reconstructs exact URLs or URL templates with confidence levels
- Supports webpack-style cross-chunk module export resolution
- Extracts request metadata (headers/body when statically recoverable)
- Supports custom sink configuration via JSON
- Exports findings as JSON, OpenAPI/Swagger, Postman, and Burp formats
- Includes profiling output for performance analysis

## Quick Install

Recommended with Bun:

```bash
bun install
bun run build
```

Run locally:

```bash
node dist/cli/index.js ./src
```

Or without building:

```bash
bun run src/cli/index.ts ./src
```

## Quick Usage

```bash
# Analyze a local project
node dist/cli/index.js ./dist

# JSON output
node dist/cli/index.js ./dist --json > findings.json

# URL target (direct mode)
node dist/cli/index.js https://example.com --site-mode direct

# Export formats
node dist/cli/index.js ./dist --export swagger > endpoints.openapi.json
node dist/cli/index.js ./dist --export postman > endpoints.postman.json
node dist/cli/index.js ./dist --export burp > endpoints.burp.txt

# Performance profile
node dist/cli/index.js ./dist --profile
```

## Example JSON Finding

```json
{
  "file": "src/api.ts",
  "line": 12,
  "column": 9,
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

## Full Documentation

See `USAGE.md` for complete documentation:

- installation details (Bun/Node)
- full CLI reference
- output format guide
- supported sinks
- custom sink config format
- analysis model and limitations
- performance tuning and profiling
- practical examples

## Development

```bash
bun run test
```
