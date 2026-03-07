import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { unionValues, unknownValue } from "../valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "../types";
import {
  addTrace,
  collectReturnExpressions,
  getParamBindingIdentifier,
  nextState,
} from "./state";

export function invokeFunctionPath(
  functionPath: NodePath<t.Function>,
  args: NodePath<t.Expression | t.SpreadElement>[],
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
  callLabel: string,
  calleeTrace: string[] = [],
): ResolvedResult {
  const fnId = `fn:${functionPath.node.start ?? 0}:${functionPath.node.end ?? 0}`;
  if (state.visited.has(fnId)) {
    return {
      value: unknownValue(`recursive:${callLabel}`),
      trace: [`CallExpression(${callLabel})`, "RecursiveGuard", ...calleeTrace],
    };
  }

  const nextVisited = new Set(state.visited);
  nextVisited.add(fnId);

  const argResolved = args.map((argPath) => {
    if (!argPath.isExpression()) {
      return {
        value: unknownValue("spread-arg"),
        trace: ["SpreadArgument"],
      };
    }
    return resolveExpression(argPath, nextState(state, { visited: nextVisited }));
  });

  const localEnv = new Map(state.env);
  functionPath.node.params.forEach((param, index) => {
    const bindingIdentifier = getParamBindingIdentifier(functionPath, param);
    if (!bindingIdentifier) {
      return;
    }

    const resolvedArg = argResolved[index]?.value;
    if (resolvedArg) {
      localEnv.set(bindingIdentifier, resolvedArg);
      return;
    }

    if (t.isAssignmentPattern(param) && t.isExpression(param.right)) {
      const defaultPath =
        functionPath.get(`params.${index}.right`) as NodePath<t.Expression>;
      const defaultResolved = resolveExpression(
        defaultPath,
        nextState(state, { visited: nextVisited, env: localEnv }),
      );
      localEnv.set(bindingIdentifier, defaultResolved.value);
      return;
    }

    localEnv.set(bindingIdentifier, unknownValue(`missing-arg-${index}`));
  });

  const returnExpressions = collectReturnExpressions(functionPath);
  if (returnExpressions.length === 0) {
    return {
      value: unknownValue(`no-return:${callLabel}`),
      trace: [`CallExpression(${callLabel})`, ...calleeTrace, "NoReturn"],
    };
  }

  const returnResolved = returnExpressions.map((returnPath) =>
    resolveExpression(
      returnPath,
      nextState(state, {
        env: localEnv,
        visited: nextVisited,
      }),
    ),
  );

  return {
    value: unionValues(returnResolved.map((result) => result.value)),
    trace: addTrace(`CallExpression(${callLabel})`, [
      calleeTrace,
      ...argResolved.map((result) => result.trace),
      ...returnResolved.map((result) => result.trace),
    ]),
  };
}

export function getFunctionPathFromCallee(
  calleePath: NodePath<t.Expression | t.V8IntrinsicIdentifier | t.Super>,
): NodePath<t.Function> | null {
  if (calleePath.isFunctionExpression() || calleePath.isArrowFunctionExpression()) {
    return calleePath as NodePath<t.Function>;
  }

  if (!calleePath.isIdentifier()) {
    return null;
  }

  const binding = calleePath.scope.getBinding(calleePath.node.name);
  if (!binding) {
    return null;
  }

  if (binding.path.isFunctionDeclaration()) {
    return binding.path as NodePath<t.Function>;
  }

  if (
    binding.path.isFunctionExpression() ||
    binding.path.isArrowFunctionExpression()
  ) {
    return binding.path as NodePath<t.Function>;
  }

  if (binding.path.isVariableDeclarator()) {
    const initPath = binding.path.get("init");
    if (initPath.isFunctionExpression() || initPath.isArrowFunctionExpression()) {
      return initPath as NodePath<t.Function>;
    }
  }

  return null;
}
