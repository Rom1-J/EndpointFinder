import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { expressionToPath } from "../utils/ast";
import {
  axiosInstanceValue,
  dynamicValue,
  getObjectProperty,
  literalValue,
  unknownValue,
  type ResolvedValue,
} from "./valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "./types";
import {
  getFunctionPathFromCallee,
  invokeFunctionPath,
} from "./call/invokeFunction";
import { resolveKnownMemberCall } from "./call/knownMemberCall";
import { resolveNewExpression } from "./call/newExpression";
import { resolveWebpackRequireCall } from "./call/webpackRequire";
import {
  getArgumentExpressionPath,
  getCallArguments,
  nextState,
  unwrapCalleePath,
} from "./call/state";

export { getFunctionPathFromCallee, resolveNewExpression };

export function resolveCallExpression(
  path: NodePath<t.CallExpression>,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult {
  if (state.depth >= state.context.maxDepth) {
    return {
      value: unknownValue("max-depth-call"),
      trace: ["CallExpression", "DepthLimit"],
    };
  }

  const rawCalleePath = path.get("callee") as NodePath<
    t.Expression | t.V8IntrinsicIdentifier | t.Super
  >;
  const calleePath = unwrapCalleePath(rawCalleePath);
  const calleeName = calleePath.isExpression()
    ? expressionToPath(calleePath.node as t.Expression)
    : null;

  const webpackRequireResolved = resolveWebpackRequireCall(
    path,
    calleePath,
    state,
    resolveExpression,
  );
  if (webpackRequireResolved) {
    return webpackRequireResolved;
  }

  const knownMemberResolved = resolveKnownMemberCall(
    path,
    calleePath,
    state,
    resolveExpression,
  );
  if (knownMemberResolved) {
    return knownMemberResolved;
  }

  if (calleeName === "axios.create") {
    const argPath = getArgumentExpressionPath(path, 0);
    if (!argPath) {
      return {
        value: axiosInstanceValue(unknownValue("axios-create-baseURL")),
        trace: ["CallExpression(axios.create)", "NoConfig"],
      };
    }
    const configResolved = resolveExpression(argPath, nextState(state));
    const baseURL =
      getObjectProperty(configResolved.value, "baseURL") ??
      unknownValue("axios-create-baseURL");

    return {
      value: axiosInstanceValue(baseURL),
      trace: ["CallExpression(axios.create)", ...configResolved.trace],
    };
  }

  if (calleePath.isIdentifier({ name: "URLSearchParams" })) {
    const firstArg = getArgumentExpressionPath(path, 0);
    if (firstArg && firstArg.isStringLiteral()) {
      return {
        value: literalValue(firstArg.node.value),
        trace: ["CallExpression(URLSearchParams)", "StringLiteral"],
      };
    }
    return {
      value: dynamicValue("queryParams"),
      trace: ["CallExpression(URLSearchParams)", "DynamicQuery"],
    };
  }

  let functionPath = getFunctionPathFromCallee(calleePath);
  let calleeTrace: string[] = [];
  let callableReturnValue: ResolvedValue | null = null;

  if (!functionPath && calleePath.isExpression()) {
    const resolvedCallee = resolveExpression(
      calleePath as NodePath<t.Expression>,
      nextState(state),
    );
    calleeTrace = resolvedCallee.trace;
    if (resolvedCallee.value.kind === "callable") {
      callableReturnValue = resolvedCallee.value.returnValue;
    }
    if (resolvedCallee.value.kind === "functionRef") {
      functionPath =
        state.context.functionPaths.get(resolvedCallee.value.functionNode) ?? null;
    }
  }

  if (callableReturnValue) {
    return {
      value: callableReturnValue,
      trace: [`CallExpression(${calleeName ?? "callable"})`, ...calleeTrace, "InvokeCallable"],
    };
  }

  if (!functionPath) {
    return {
      value: unknownValue(`call:${calleeName ?? "unknown"}`),
      trace: [`CallExpression(${calleeName ?? "unknown"})`, ...calleeTrace, "UnknownCall"],
    };
  }

  return invokeFunctionPath(
    functionPath,
    getCallArguments(path),
    state,
    resolveExpression,
    calleeName ?? "function",
    calleeTrace,
  );
}
