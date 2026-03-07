import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
  arrayValue,
  functionRefValue,
  objectValue,
  unknownValue,
} from "../valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "../types";
import { combineTrace, nextState } from "./state";

export function resolveObjectExpression(
  path: NodePath<t.ObjectExpression>,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult {
  const properties: Record<string, ReturnType<ResolveExpressionFn>["value"]> = {};
  const traces: string[][] = [];

  for (const propPath of path.get("properties")) {
    if (propPath.isSpreadElement()) {
      continue;
    }
    if (propPath.isObjectMethod()) {
      const keyNode = propPath.node.key;
      let key: string | null = null;
      if (t.isIdentifier(keyNode) && !propPath.node.computed) {
        key = keyNode.name;
      } else if (t.isStringLiteral(keyNode)) {
        key = keyNode.value;
      }
      if (!key) {
        continue;
      }

      properties[key] = functionRefValue(propPath.node, `objectMethod:${key}`);
      traces.push([`ObjectMethod(${key})`]);
      continue;
    }
    if (!propPath.isObjectProperty()) {
      continue;
    }
    const keyNode = propPath.node.key;
    let key: string | null = null;
    if (t.isIdentifier(keyNode) && !propPath.node.computed) {
      key = keyNode.name;
    } else if (t.isStringLiteral(keyNode)) {
      key = keyNode.value;
    }
    if (!key) {
      continue;
    }

    const valuePath = propPath.get("value");
    if (!valuePath.isExpression()) {
      continue;
    }
    const resolved = resolveExpression(valuePath, nextState(state));
    properties[key] = resolved.value;
    traces.push(resolved.trace);
  }

  return {
    value: objectValue(properties),
    trace: combineTrace("ObjectExpression", traces),
  };
}

export function resolveArrayExpression(
  path: NodePath<t.ArrayExpression>,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult {
  const elements = [];
  const traces: string[][] = [];

  for (const elementPath of path.get("elements")) {
    if (!elementPath || !elementPath.isExpression()) {
      elements.push(unknownValue("array-hole"));
      continue;
    }
    const resolved = resolveExpression(elementPath, nextState(state));
    elements.push(resolved.value);
    traces.push(resolved.trace);
  }

  return {
    value: arrayValue(elements),
    trace: combineTrace("ArrayExpression", traces),
  };
}
