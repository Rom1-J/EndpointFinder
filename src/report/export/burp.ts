import type { AnalyzeProjectResult } from "../../types";
import { ABSOLUTE_URL, toExportEndpoints } from "./common";
import { ensureLeadingSlash, getDefaultBaseUrl, splitUrlParts } from "./url";

export function toBurpExport(result: AnalyzeProjectResult): string {
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
