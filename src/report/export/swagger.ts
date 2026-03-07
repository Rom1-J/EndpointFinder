import type { AnalyzeProjectResult } from "../../types";
import { findContentType, toExportEndpoints } from "./common";
import { parseQueryNames, splitUrlParts } from "./url";

export function toSwaggerExport(result: AnalyzeProjectResult): string {
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
