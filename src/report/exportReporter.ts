import type { AnalyzeProjectResult, Finding } from "../types";

export type ExportFormat = "swagger" | "postman" | "burp";

interface ExportEndpoint {
  finding: Finding;
  method: string;
  urlRaw: string;
  headers: Array<{ name: string; value: string }>;
  body: string | null;
}

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

function sanitizeVarName(raw: string): string {
  const compact = raw
    .replace(/^\$+/, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .toLowerCase();
  return compact.length > 0 ? compact : "dynamic";
}

function replaceInterpolations(
  input: string,
  mode: "swagger" | "postman" | "burp",
): string {
  const seen = new Map<string, number>();
  return input.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const base = sanitizeVarName(expr);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const name = count === 0 ? base : `${base}_${count + 1}`;
    if (mode === "swagger") {
      return `{${name}}`;
    }
    return `{{${name}}}`;
  });
}

function inferMethod(finding: Finding): string {
  if (finding.method) {
    return finding.method.toUpperCase();
  }

  const sink = finding.sink.toLowerCase();
  if (sink.includes("sendbeacon")) {
    return "POST";
  }
  if (sink.includes("post")) {
    return "POST";
  }
  if (sink.includes("put")) {
    return "PUT";
  }
  if (sink.includes("patch")) {
    return "PATCH";
  }
  if (sink.includes("delete")) {
    return "DELETE";
  }
  return "GET";
}

function isHttpLikeTarget(urlRaw: string): boolean {
  if (ABSOLUTE_URL.test(urlRaw)) {
    return /^https?:\/\//i.test(urlRaw);
  }
  return urlRaw.startsWith("/") || urlRaw.startsWith("{{") || urlRaw.startsWith("{");
}

function pickMetadataValue(value: string | null, template: string | null): string | null {
  if (value !== null) {
    return value;
  }
  if (template !== null) {
    return template;
  }
  return null;
}

function normalizeHeaders(finding: Finding, mode: "postman" | "swagger" | "burp") {
  const headers = finding.headers ?? [];
  return headers
    .map((header) => {
      const picked = pickMetadataValue(header.value, header.valueTemplate);
      if (picked === null) {
        return null;
      }
      return {
        name: header.name,
        value: replaceInterpolations(picked, mode),
      };
    })
    .filter((header): header is { name: string; value: string } => header !== null);
}

function normalizeBody(finding: Finding, mode: "postman" | "swagger" | "burp"): string | null {
  const bodyValue = finding.body
    ? pickMetadataValue(finding.body.value, finding.body.valueTemplate)
    : null;
  if (bodyValue === null) {
    return null;
  }
  return replaceInterpolations(bodyValue, mode);
}

function toExportEndpoints(
  result: AnalyzeProjectResult,
  mode: "postman" | "swagger" | "burp",
): ExportEndpoint[] {
  return result.findings
    .map((finding) => {
      const raw = finding.url ?? finding.urlTemplate;
      if (!raw) {
        return null;
      }

      const method = inferMethod(finding);
      if (!HTTP_METHODS.has(method)) {
        return null;
      }

      const transformed = replaceInterpolations(raw, mode);
      if (!isHttpLikeTarget(transformed)) {
        return null;
      }

      return {
        finding,
        method,
        urlRaw: transformed,
        headers: normalizeHeaders(finding, mode),
        body: normalizeBody(finding, mode),
      } satisfies ExportEndpoint;
    })
    .filter((endpoint): endpoint is ExportEndpoint => endpoint !== null);
}

function ensureLeadingSlash(pathValue: string): string {
  if (pathValue.startsWith("/")) {
    return pathValue;
  }
  return `/${pathValue}`;
}

function splitUrlParts(urlRaw: string): {
  origin: string | null;
  path: string;
  query: string;
} {
  const [pathWithQuery] = urlRaw.split("#", 1);

  if (ABSOLUTE_URL.test(pathWithQuery)) {
    const sanitized = pathWithQuery
      .replace(/\{[^}]+\}/g, "dynamic")
      .replace(/\{\{[^}]+\}\}/g, "dynamic");
    try {
      const parsed = new URL(sanitized);
      const origin = `${parsed.protocol}//${parsed.host}`;
      const withoutOrigin = pathWithQuery.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/]+/, "");
      const [pathPart, queryPart = ""] = withoutOrigin.split("?", 2);
      return {
        origin,
        path: ensureLeadingSlash(pathPart || "/"),
        query: queryPart,
      };
    } catch {
      // fall through
    }
  }

  const [pathPart, queryPart = ""] = pathWithQuery.split("?", 2);
  return {
    origin: null,
    path: ensureLeadingSlash(pathPart || "/"),
    query: queryPart,
  };
}

function parseQueryNames(query: string): string[] {
  if (!query) {
    return [];
  }

  const names = new Set<string>();
  for (const pair of query.split("&")) {
    if (!pair) {
      continue;
    }
    const [namePart] = pair.split("=", 1);
    const name = namePart.trim();
    if (name) {
      names.add(name);
    }
  }

  return [...names];
}

function findContentType(headers: Array<{ name: string; value: string }>): string {
  const matched = headers.find((header) => header.name.toLowerCase() === "content-type");
  if (!matched) {
    return "application/json";
  }
  return matched.value.split(";")[0].trim() || "application/json";
}

function toSwaggerExport(result: AnalyzeProjectResult): string {
  const endpoints = toExportEndpoints(result, "swagger");

  const servers = new Set<string>();
  const paths: Record<string, Record<string, unknown>> = {};

  endpoints.forEach((endpoint, index) => {
    const parts = splitUrlParts(endpoint.urlRaw);
    if (parts.origin) {
      servers.add(parts.origin);
    }

    const queryNames = parseQueryNames(parts.query);
    const pathKey = parts.path;
    const methodKey = endpoint.method.toLowerCase();

    const pathEntry = paths[pathKey] ?? {};

    const parameters: Array<Record<string, unknown>> = [
      ...queryNames.map((name) => ({
        name,
        in: "query",
        required: false,
        schema: { type: "string" },
      })),
      ...endpoint.headers.map((header) => ({
        name: header.name,
        in: "header",
        required: false,
        schema: { type: "string" },
        example: header.value,
      })),
    ];

    const operation: Record<string, unknown> = {
      operationId: `endpoint_${index + 1}`,
      summary: `${endpoint.method} ${pathKey}`,
      tags: [endpoint.finding.sink],
      parameters,
      responses: {
        "200": {
          description: "Successful response",
        },
      },
      "x-endpointfinder": {
        file: endpoint.finding.file,
        line: endpoint.finding.line,
        column: endpoint.finding.column,
        confidence: endpoint.finding.confidence,
      },
    };

    if (endpoint.body !== null) {
      operation.requestBody = {
        required: true,
        content: {
          [findContentType(endpoint.headers)]: {
            example: endpoint.body,
          },
        },
      };
    }

    pathEntry[methodKey] = operation;
    paths[pathKey] = pathEntry;
  });

  let defaultServer = "https://example.com";
  try {
    if (/^https?:\/\//i.test(result.target)) {
      const parsed = new URL(result.target);
      defaultServer = `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    // no-op
  }

  const swagger = {
    openapi: "3.0.3",
    info: {
      title: "EndpointFinder Export",
      version: "1.0.0",
      description: "Generated from static endpoint analysis",
    },
    servers: [...servers].length > 0 ? [...servers].map((url) => ({ url })) : [{ url: defaultServer }],
    paths,
  };

  return JSON.stringify(swagger, null, 2);
}

function getDefaultBaseUrl(result: AnalyzeProjectResult, endpoints: ExportEndpoint[]): string {
  for (const endpoint of endpoints) {
    const parts = splitUrlParts(endpoint.urlRaw);
    if (parts.origin) {
      return parts.origin;
    }
  }

  if (/^https?:\/\//i.test(result.target)) {
    try {
      const parsed = new URL(result.target);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      // ignore
    }
  }

  return "https://example.com";
}

function toPostmanUrl(rawUrl: string): { raw: string; host?: string[]; path?: string[]; query?: Array<{ key: string; value: string }> } {
  const parts = splitUrlParts(rawUrl);
  const queryPairs = parts.query
    ? parts.query.split("&").filter(Boolean).map((pair) => {
        const [key, value = ""] = pair.split("=", 2);
        return { key, value };
      })
    : [];

  if (parts.origin) {
    const host = parts.origin.replace(/^https?:\/\//, "").split(".");
    const pathSegments = parts.path.split("/").filter(Boolean);
    return {
      raw: rawUrl,
      host,
      path: pathSegments,
      query: queryPairs,
    };
  }

  const pathSegments = parts.path.split("/").filter(Boolean);
  return {
    raw: rawUrl,
    path: pathSegments,
    query: queryPairs,
  };
}

function toPostmanExport(result: AnalyzeProjectResult): string {
  const endpoints = toExportEndpoints(result, "postman");
  const baseUrl = getDefaultBaseUrl(result, endpoints);

  const hasRelative = endpoints.some((endpoint) => !ABSOLUTE_URL.test(endpoint.urlRaw));

  const items = endpoints.map((endpoint, index) => {
    const rawUrl = ABSOLUTE_URL.test(endpoint.urlRaw)
      ? endpoint.urlRaw
      : `{{baseUrl}}${ensureLeadingSlash(endpoint.urlRaw)}`;

    const request: Record<string, unknown> = {
      method: endpoint.method,
      header: endpoint.headers.map((header) => ({
        key: header.name,
        value: header.value,
        type: "text",
      })),
      url: toPostmanUrl(rawUrl),
      description: `source: ${endpoint.finding.file}:${endpoint.finding.line}:${endpoint.finding.column}`,
    };

    if (endpoint.body !== null) {
      request.body = {
        mode: "raw",
        raw: endpoint.body,
      };
    }

    return {
      name: `${String(index + 1).padStart(2, "0")} ${endpoint.method} ${endpoint.urlRaw}`,
      request,
      response: [],
    };
  });

  const collection: Record<string, unknown> = {
    info: {
      name: "EndpointFinder Export",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      description: "Generated from static endpoint analysis",
    },
    item: items,
  };

  if (hasRelative) {
    collection.variable = [
      {
        key: "baseUrl",
        value: baseUrl,
      },
    ];
  }

  return JSON.stringify(collection, null, 2);
}

function toBurpExport(result: AnalyzeProjectResult): string {
  const endpoints = toExportEndpoints(result, "burp");
  const defaultBase = getDefaultBaseUrl(result, endpoints);

  const blocks: string[] = [];
  blocks.push("# EndpointFinder Burp Repeater Export");
  blocks.push("# Copy one request block at a time into Burp Repeater.");
  blocks.push("");

  endpoints.forEach((endpoint, index) => {
    const normalized = ABSOLUTE_URL.test(endpoint.urlRaw)
      ? endpoint.urlRaw
      : `${defaultBase}${ensureLeadingSlash(endpoint.urlRaw)}`;

    const parts = splitUrlParts(normalized);
    const host = (parts.origin ?? defaultBase).replace(/^https?:\/\//, "");
    const requestTarget = parts.query ? `${parts.path}?${parts.query}` : parts.path;

    blocks.push(`### Request ${index + 1} - ${endpoint.method} ${endpoint.urlRaw}`);
    blocks.push(`${endpoint.method} ${requestTarget} HTTP/1.1`);
    blocks.push(`Host: ${host}`);

    for (const header of endpoint.headers) {
      if (header.name.toLowerCase() === "host") {
        continue;
      }
      blocks.push(`${header.name}: ${header.value}`);
    }

    blocks.push("");
    if (endpoint.body !== null) {
      blocks.push(endpoint.body);
    }
    blocks.push("");
  });

  return blocks.join("\n");
}

export function toExportReport(
  result: AnalyzeProjectResult,
  format: ExportFormat,
): string {
  if (format === "swagger") {
    return toSwaggerExport(result);
  }
  if (format === "postman") {
    return toPostmanExport(result);
  }
  return toBurpExport(result);
}
