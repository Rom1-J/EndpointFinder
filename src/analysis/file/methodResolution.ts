import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { getObjectProperty, joinBaseAndPath, type ResolvedValue } from "../../resolver/valueModel";
import type { ResolvedResult } from "../../resolver/types";

type ResolveFn = (path: NodePath<t.Expression>) => ResolvedResult;

function getArgumentExpressionPath(
  path: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  index: number,
): NodePath<t.Expression> | null {
  const args = path.get("arguments") as NodePath<
    t.Expression | t.SpreadElement
  >[];
  const argPath = args[index];
  if (!argPath || !argPath.isExpression()) {
    return null;
  }
  return argPath as NodePath<t.Expression>;
}

export function toHttpMethod(value: ResolvedValue | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value.kind === "literal") {
    return value.value.toUpperCase();
  }
  if (value.kind === "union") {
    const literalOptions = value.options.filter(
      (option): option is Extract<ResolvedValue, { kind: "literal" }> =>
        option.kind === "literal",
    );
    if (literalOptions.length === 1) {
      return literalOptions[0].value.toUpperCase();
    }
  }
  return null;
}

function methodFromObjectConfig(
  config: ResolvedValue | undefined,
): string | null {
  if (!config) {
    return null;
  }
  return toHttpMethod(getObjectProperty(config, "method"));
}

export function resolveAxiosCall(
  callPath: NodePath<t.CallExpression>,
  resolve: ResolveFn,
): {
  urlValue: ResolvedValue | null;
  method: string | null;
  trace: string[];
} {
  const firstArg = getArgumentExpressionPath(callPath, 0);
  if (!firstArg || !firstArg.isExpression()) {
    return {
      urlValue: null,
      method: null,
      trace: ["AxiosCall", "NoArguments"],
    };
  }

  const firstResolved = resolve(firstArg);
  let urlValue: ResolvedValue | null = firstResolved.value;
  let method = methodFromObjectConfig(firstResolved.value);
  const trace = ["AxiosCall", ...firstResolved.trace];

  const fromConfigUrl = getObjectProperty(firstResolved.value, "url");
  const fromConfigBaseURL = getObjectProperty(firstResolved.value, "baseURL");

  if (fromConfigUrl) {
    urlValue = fromConfigUrl;
    trace.push("AxiosConfig.url");
  }

  if (fromConfigBaseURL && urlValue) {
    urlValue = joinBaseAndPath(fromConfigBaseURL, urlValue);
    trace.push("AxiosConfig.baseURL");
  }

  const secondArg = getArgumentExpressionPath(callPath, 1);
  if (secondArg && secondArg.isExpression()) {
    const secondResolved = resolve(secondArg);
    trace.push(...secondResolved.trace);

    method = method ?? methodFromObjectConfig(secondResolved.value);

    const extraBase = getObjectProperty(secondResolved.value, "baseURL");
    if (extraBase && urlValue) {
      urlValue = joinBaseAndPath(extraBase, urlValue);
      trace.push("AxiosSecondConfig.baseURL");
    }
  }

  method = method ?? "GET";

  return {
    urlValue,
    method,
    trace,
  };
}

export function resolveFetchLikeMethod(
  callPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  resolve: ResolveFn,
): string | null {
  const initPath = getArgumentExpressionPath(callPath, 1);
  if (!initPath || !initPath.isExpression()) {
    return null;
  }
  const initResolved = resolve(initPath);
  return methodFromObjectConfig(initResolved.value);
}

export function resolveAxiosMethodBaseURL(
  callPath: NodePath<t.CallExpression>,
  resolve: ResolveFn,
): ResolvedValue | null {
  const configPath = getArgumentExpressionPath(callPath, 1);
  if (!configPath || !configPath.isExpression()) {
    return null;
  }
  const configResolved = resolve(configPath);
  return getObjectProperty(configResolved.value, "baseURL") ?? null;
}
