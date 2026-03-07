import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
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

export function bindingKey(binding: Binding): string {
  const start = binding.identifier.start ?? 0;
  const end = binding.identifier.end ?? 0;
  return `${binding.identifier.name}:${start}:${end}`;
}

export function parameterIndex(
  functionPath: NodePath<t.Function>,
  identifier: t.Identifier,
): number {
  for (let index = 0; index < functionPath.node.params.length; index += 1) {
    const param = functionPath.node.params[index];
    if (t.isRestElement(param) && t.isIdentifier(param.argument) && param.argument === identifier) {
      return index;
    }
    if (t.isIdentifier(param) && param === identifier) {
      return index;
    }
    if (t.isAssignmentPattern(param) && t.isIdentifier(param.left) && param.left === identifier) {
      return index;
    }
  }
  return -1;
}

export function mergeTrace(prefix: string, traces: string[][]): string[] {
  const output = [prefix];
  for (const trace of traces) {
    output.push(...trace);
  }
  return output;
}
