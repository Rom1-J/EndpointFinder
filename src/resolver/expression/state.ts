import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { dedupeTrace } from "../../utils/ast";
import type { ResolverState } from "../types";

export function nextState(
  state: ResolverState,
  overrides: Partial<ResolverState> = {},
): ResolverState {
  return {
    ...state,
    ...overrides,
    depth: overrides.depth ?? state.depth + 1,
  };
}

export function combineTrace(prefix: string, parts: string[][]): string[] {
  const trace = [prefix];
  for (const part of parts) {
    trace.push(...part);
  }
  return dedupeTrace(trace);
}

export function unwrapTypeExpressions(
  path: NodePath<t.Expression>,
): NodePath<t.Expression> {
  if (path.isTSAsExpression() || path.isTSTypeAssertion() || path.isTSNonNullExpression()) {
    const nested = path.get("expression") as NodePath<t.Expression>;
    if (nested.isExpression()) {
      return unwrapTypeExpressions(nested);
    }
  }
  return path;
}
