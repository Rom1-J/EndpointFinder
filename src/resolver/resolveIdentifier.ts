import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { dynamicValue, functionRefValue, unknownValue } from "./valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "./types";
import { resolveObjectDestructuredBinding } from "./identifier/resolveDestructured";
import { resolveParamFromCallSites } from "./identifier/resolveParam";
import { resolveVariableBinding } from "./identifier/resolveVariable";
import { bindingKey, nextState } from "./identifier/state";

export function resolveIdentifier(
  path: NodePath<t.Identifier>,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult {
  if (state.depth >= state.context.maxDepth) {
    return {
      value: unknownValue(`depth:${path.node.name}`),
      trace: [`Identifier(${path.node.name})`, "DepthLimit"],
    };
  }

  const binding = path.scope.getBinding(path.node.name);
  if (!binding) {
    const globalValue = state.context.globalSymbolValues.get(path.node.name);
    if (globalValue) {
      return {
        value: globalValue,
        trace: [`Identifier(${path.node.name})`, "GlobalSymbol"],
      };
    }

    return {
      value: dynamicValue(path.node.name),
      trace: [`Identifier(${path.node.name})`, "UnboundDynamic"],
    };
  }

  const envValue = state.env.get(binding.identifier);
  if (envValue) {
    return {
      value: envValue,
      trace: [`Identifier(${path.node.name})`, "ParamBinding"],
    };
  }

  const key = bindingKey(binding);
  if (state.visited.has(key)) {
    return {
      value: unknownValue(`cycle:${path.node.name}`),
      trace: [`Identifier(${path.node.name})`, "CycleGuard"],
    };
  }

  const visited = new Set(state.visited);
  visited.add(key);
  const nestedState = nextState(state, { visited });

  if (binding.kind === "module") {
    return {
      value: unknownValue(`import:${path.node.name}`),
      trace: [`Identifier(${path.node.name})`, "ImportBinding"],
    };
  }

  if (binding.kind === "param") {
    return resolveParamFromCallSites(path, binding, nestedState, resolveExpression);
  }

  if (
    binding.path.isVariableDeclarator() ||
    binding.path.isAssignmentExpression() ||
    binding.path.isUpdateExpression()
  ) {
    return resolveVariableBinding(path, binding, nestedState, resolveExpression);
  }

  const destructured = resolveObjectDestructuredBinding(
    path,
    binding,
    nestedState,
    resolveExpression,
  );
  if (destructured) {
    return destructured;
  }

  if (
    binding.path.isFunctionDeclaration() ||
    binding.path.isFunctionExpression() ||
    binding.path.isArrowFunctionExpression()
  ) {
    return {
      value: functionRefValue(binding.path.node, `binding:${path.node.name}`),
      trace: [`Identifier(${path.node.name})`, "FunctionBinding"],
    };
  }

  return {
    value: unknownValue(`binding:${binding.kind}`),
    trace: [`Identifier(${path.node.name})`, `Binding(${binding.kind})`],
  };
}
