import type { AnalyzeProjectResult, Finding } from "../../types";
import type { ExportEndpoint } from "./types";

export const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

function sanitizeVarName(raw: string): string {
  const compact = raw
    .replace(/^\$+/, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .toLowerCase();
  return compact.length > 0 ? compact : "dynamic";
}

export function replaceInterpolations(
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

export function toExportEndpoints(
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

export function findContentType(headers: Array<{ name: string; value: string }>): string {
  const matched = headers.find((header) => header.name.toLowerCase() === "content-type");
  if (!matched) {
    return "application/json";
  }
  return matched.value.split(";")[0].trim() || "application/json";
}
