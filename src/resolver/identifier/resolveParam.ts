import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { dynamicValue, unknownValue, unionValues } from "../valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "../types";
import { mergeTrace, nextState, parameterIndex } from "./state";

export function resolveParamFromCallSites(
  path: NodePath<t.Identifier>,
  binding: Binding,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult {
  const functionPath = binding.path.findParent((parentPath) =>
    parentPath.isFunction(),
  ) as NodePath<t.Function> | null;
  if (!functionPath) {
    return {
      value: dynamicValue(path.node.name),
      trace: [`Identifier(${path.node.name})`, "ParamWithoutFunction"],
    };
  }

  const index = parameterIndex(functionPath, binding.identifier);
  if (index < 0) {
    return {
      value: dynamicValue(path.node.name),
      trace: [`Identifier(${path.node.name})`, "ParamIndexMissing"],
    };
  }

  const callSites = state.context.callSitesByFunction.get(functionPath.node) ?? [];
  if (callSites.length === 0) {
    return {
      value: dynamicValue(path.node.name),
      trace: [`Identifier(${path.node.name})`, "NoCallSites"],
    };
  }

  const resolvedArgs = callSites.map((callPath) => {
    const argPath = callPath.get(`arguments.${index}`);
    if (!argPath || !argPath.isExpression()) {
      return {
        value: unknownValue(`missing-arg-${index}`),
        trace: ["MissingArgument"],
      };
    }
    return resolveExpression(argPath, nextState(state));
  });

  const values = resolvedArgs.map((result) => result.value);
  const trace = mergeTrace(
    `Identifier(${path.node.name})`,
    resolvedArgs.map((result) => result.trace),
  );

  return {
    value: unionValues(values),
    trace,
  };
}
