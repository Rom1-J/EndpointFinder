import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { FindingBody, FindingHeader } from "../../../types";
import { getObjectProperty, type ResolvedValue } from "../../../resolver/valueModel";
import {
  firstDefined,
  getObjectPropertyExpression,
  type ResolveFn,
} from "./args";
import { resolveBodyFromExpression } from "./body";
import { extractHeadersFromValue, renderMetadataValueDetailed } from "./render";

export function requestMetadataFromConfig(
  config: ResolvedValue | null,
  configPath: NodePath<t.Expression> | null,
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  resolve: ResolveFn,
): {
  headers: FindingHeader[];
  body: FindingBody | null;
} {
  if (!config) {
    return { headers: [], body: null };
  }

  const headersValue = getObjectProperty(config, "headers") ?? null;
  const bodyValue =
    firstDefined(
      getObjectProperty(config, "data"),
      getObjectProperty(config, "body"),
    ) ?? null;

  const headers = headersValue ? extractHeadersFromValue(headersValue) : [];
  let body: ReturnType<typeof renderMetadataValueDetailed> | null = null;

  const directBodyExpression =
    getObjectPropertyExpression(configPath, "data") ??
    getObjectPropertyExpression(configPath, "body");
  if (directBodyExpression) {
    const resolvedBody = resolveBodyFromExpression(directBodyExpression, sinkPath, resolve);
    body = {
      value: resolvedBody.value,
      valueTemplate: resolvedBody.valueTemplate,
      confidence: resolvedBody.confidence,
    };
  } else if (bodyValue) {
    body = renderMetadataValueDetailed(
      bodyValue,
      bodyValue.kind === "object" || bodyValue.kind === "array" ? "json" : "inline",
    );
  }

  return {
    headers,
    body: body
      ? {
          value: body.value,
          valueTemplate: body.valueTemplate,
          confidence: body.confidence,
        }
      : null,
  };
}

export function mergeHeaders(
  left: FindingHeader[],
  right: FindingHeader[],
): FindingHeader[] {
  const merged = new Map<string, FindingHeader>();
  for (const header of [...left, ...right]) {
    merged.set(header.name.toLowerCase(), header);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
