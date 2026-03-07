import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import type { ResolvedValue } from "./valueModel";

export interface WebpackModuleInfo {
  id: string;
  functionPath: NodePath<t.Function>;
  requireParamName: string | null;
  exportsParamName: string | null;
  exports: Map<string, string>;
}

export interface ResolverContext {
  callSitesByFunction: Map<t.Function, NodePath<t.CallExpression>[]>;
  functionPaths: Map<t.Function, NodePath<t.Function>>;
  webpackModulesById: Map<string, WebpackModuleInfo>;
  webpackModuleByFunction: Map<t.Function, WebpackModuleInfo>;
  webpackExternalModulesById: Map<string, Record<string, ResolvedValue>>;
  globalSymbolValues: Map<string, ResolvedValue>;
  memberAssignments: Map<string, NodePath<t.Expression>[]>;
  maxDepth: number;
}

export interface ResolverState {
  context: ResolverContext;
  env: Map<t.Identifier, ResolvedValue>;
  visited: Set<string>;
  depth: number;
}

export interface ResolvedResult {
  value: ResolvedValue;
  trace: string[];
}

export type ResolveExpressionFn = (
  path: NodePath<t.Expression>,
  state: ResolverState,
) => ResolvedResult;
