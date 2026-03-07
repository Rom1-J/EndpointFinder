import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { resolveExpression } from "../../resolver/resolveExpression";
import type { ResolverContext, ResolverState, ResolvedResult } from "../../resolver/types";
import { elapsedMs, nowMs } from "../../utils/perf";

export interface TopLevelResolverMetrics {
  resolveCalls: number;
  cacheHits: number;
  resolveMs: number;
}

function resolveWithState(
  expressionPath: NodePath<t.Expression>,
  context: ResolverContext,
): ResolvedResult {
  const initialState: ResolverState = {
    context,
    env: new Map(),
    visited: new Set(),
    depth: 0,
  };
  return resolveExpression(expressionPath, initialState);
}

export function createTopLevelResolver(context: ResolverContext): {
  resolve: (path: NodePath<t.Expression>) => ResolvedResult;
  resolveUncached: (path: NodePath<t.Expression>) => ResolvedResult;
  clearCache: () => void;
  metrics: TopLevelResolverMetrics;
} {
  // Cache only top-level expression resolutions (empty env/visited state).
  // This avoids repeated backward-resolution of the same AST node during sink matching
  // and metadata extraction while keeping resolver semantics deterministic.
  let cache = new WeakMap<t.Expression, ResolvedResult>();
  const metrics: TopLevelResolverMetrics = {
    resolveCalls: 0,
    cacheHits: 0,
    resolveMs: 0,
  };

  const resolveUncached = (path: NodePath<t.Expression>): ResolvedResult => {
    const start = nowMs();
    const result = resolveWithState(path, context);
    metrics.resolveMs += elapsedMs(start);
    return result;
  };

  const resolve = (path: NodePath<t.Expression>): ResolvedResult => {
    metrics.resolveCalls += 1;
    const cached = cache.get(path.node);
    if (cached) {
      metrics.cacheHits += 1;
      return cached;
    }
    const result = resolveUncached(path);
    cache.set(path.node, result);
    return result;
  };

  return {
    resolve,
    resolveUncached,
    clearCache: () => {
      cache = new WeakMap<t.Expression, ResolvedResult>();
    },
    metrics,
  };
}
