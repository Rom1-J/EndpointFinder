import type { AnalyzeProjectResult } from "../../types";
import type { ExportEndpoint } from "./types";
import { ABSOLUTE_URL } from "./common";

export function ensureLeadingSlash(pathValue: string): string {
  if (pathValue.startsWith("/")) {
    return pathValue;
  }
  return `/${pathValue}`;
}

export function splitUrlParts(urlRaw: string): {
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

export function parseQueryNames(query: string): string[] {
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

export function getDefaultBaseUrl(result: AnalyzeProjectResult, endpoints: ExportEndpoint[]): string {
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

export function toPostmanUrl(rawUrl: string): {
  raw: string;
  host?: string[];
  path?: string[];
  query?: Array<{ key: string; value: string }>;
} {
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
