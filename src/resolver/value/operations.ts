import { literalValue, sinkRefValue, unknownValue } from "./constructors";
import type { ResolvedValue, SinkRefValue } from "./types";

function valueKey(value: ResolvedValue): string {
  switch (value.kind) {
    case "literal":
      return `literal:${value.value}`;
    case "dynamic":
      return `dynamic:${value.label}`;
    case "unknown":
      return `unknown:${value.reason}`;
    case "concat":
      return `concat:${value.parts.map(valueKey).join(",")}`;
    case "union":
      return `union:${value.options.map(valueKey).join("|")}`;
    case "object":
      return `object:${Object.entries(value.properties)
        .map(([key, val]) => `${key}:${valueKey(val)}`)
        .join(",")}`;
    case "array":
      return `array:${value.elements.map(valueKey).join(",")}`;
    case "functionRef": {
      const start = value.functionNode.start ?? 0;
      const end = value.functionNode.end ?? 0;
      return `functionRef:${value.label}:${start}:${end}`;
    }
    case "callable":
      return `callable:${value.label}:${valueKey(value.returnValue)}`;
    case "sinkRef":
      return `sinkRef:${value.match}:${value.sinkType}:${value.urlArg}:${
        value.methodArg ?? "none"
      }:${value.httpMethod ?? "none"}:${value.baseURL ? valueKey(value.baseURL) : "none"}`;
    case "axiosInstance":
      return `axios:${valueKey(value.baseURL)}`;
    case "xhrInstance":
      return "xhr";
    default:
      return "unknown";
  }
}

export function concatValues(parts: ResolvedValue[]): ResolvedValue {
  const flattened: ResolvedValue[] = [];

  for (const part of parts) {
    if (part.kind === "concat") {
      flattened.push(...part.parts);
      continue;
    }
    flattened.push(part);
  }

  const merged: ResolvedValue[] = [];
  for (const part of flattened) {
    const previous = merged[merged.length - 1];
    if (previous?.kind === "literal" && part.kind === "literal") {
      previous.value += part.value;
    } else {
      merged.push(part);
    }
  }

  if (merged.length === 0) {
    return literalValue("");
  }
  if (merged.length === 1) {
    return merged[0];
  }
  return {
    kind: "concat",
    parts: merged,
  };
}

export function unionValues(values: ResolvedValue[]): ResolvedValue {
  const flattened: ResolvedValue[] = [];
  for (const value of values) {
    if (value.kind === "union") {
      flattened.push(...value.options);
    } else {
      flattened.push(value);
    }
  }

  const unique: ResolvedValue[] = [];
  const seen = new Set<string>();
  for (const value of flattened) {
    const key = valueKey(value);
    if (!seen.has(key)) {
      unique.push(value);
      seen.add(key);
    }
  }

  if (unique.length === 0) {
    return unknownValue("empty-union");
  }
  if (unique.length === 1) {
    return unique[0];
  }
  return {
    kind: "union",
    options: unique,
  };
}

export function getObjectProperty(
  value: ResolvedValue,
  propertyName: string,
): ResolvedValue | undefined {
  if (value.kind === "object") {
    return value.properties[propertyName];
  }

  if (value.kind === "axiosInstance") {
    const method = propertyName.toLowerCase();
    const httpMethods: Record<string, string> = {
      get: "GET",
      post: "POST",
      put: "PUT",
      patch: "PATCH",
      delete: "DELETE",
    };
    if (httpMethods[method]) {
      return sinkRefValue({
        sinkName: `axios.${method}`,
        match: `axios.${method}`,
        sinkType: "method",
        urlArg: 0,
        httpMethod: httpMethods[method],
        baseURL: value.baseURL,
      });
    }
  }

  if (value.kind === "union") {
    const matches = value.options
      .map((option) => getObjectProperty(option, propertyName))
      .filter((option): option is ResolvedValue => option !== undefined);
    if (matches.length === 0) {
      return undefined;
    }
    return unionValues(matches);
  }

  return undefined;
}

export function isSinkRefValue(value: ResolvedValue): value is SinkRefValue {
  return value.kind === "sinkRef";
}

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

function joinLiteralBasePath(baseURL: string, path: string): string {
  if (path.length === 0) {
    return baseURL;
  }
  if (ABSOLUTE_URL.test(path)) {
    return path;
  }
  if (baseURL.length === 0) {
    return path;
  }
  if (path.startsWith("?") || path.startsWith("#")) {
    return `${baseURL}${path}`;
  }
  if (baseURL.endsWith("/") && path.startsWith("/")) {
    return `${baseURL}${path.slice(1)}`;
  }
  if (!baseURL.endsWith("/") && !path.startsWith("/")) {
    return `${baseURL}/${path}`;
  }
  return `${baseURL}${path}`;
}

export function joinBaseAndPath(
  baseURL: ResolvedValue,
  path: ResolvedValue,
): ResolvedValue {
  if (path.kind === "literal" && ABSOLUTE_URL.test(path.value)) {
    return path;
  }

  if (baseURL.kind === "literal" && path.kind === "literal") {
    return literalValue(joinLiteralBasePath(baseURL.value, path.value));
  }

  return concatValues([baseURL, path]);
}
