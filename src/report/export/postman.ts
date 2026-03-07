import type { AnalyzeProjectResult } from "../../types";
import { ABSOLUTE_URL, toExportEndpoints } from "./common";
import { ensureLeadingSlash, getDefaultBaseUrl, toPostmanUrl } from "./url";

export function toPostmanExport(result: AnalyzeProjectResult): string {
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
