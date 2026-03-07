import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { expressionToPath } from "../../utils/ast";
import {
  concatValues,
  dynamicValue,
  joinBaseAndPath,
  literalValue,
  unknownValue,
  xhrInstanceValue,
} from "../valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "../types";
import { addTrace, getArgumentExpressionPath, nextState } from "./state";

export function resolveNewExpression(
  path: NodePath<t.NewExpression>,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult {
  if (state.depth >= state.context.maxDepth) {
    return {
      value: unknownValue("max-depth-new"),
      trace: ["NewExpression", "DepthLimit"],
    };
  }

  const calleePath = path.get("callee");
  const calleeName = expressionToPath(calleePath.node as t.Expression);

  if (calleePath.isIdentifier({ name: "XMLHttpRequest" })) {
    return {
      value: xhrInstanceValue(),
      trace: ["NewExpression(XMLHttpRequest)"],
    };
  }

  if (calleePath.isIdentifier({ name: "URLSearchParams" })) {
    const firstArg = getArgumentExpressionPath(path, 0);
    if (firstArg && firstArg.isStringLiteral()) {
      return {
        value: literalValue(firstArg.node.value),
        trace: ["NewExpression(URLSearchParams)", "StringLiteral"],
      };
    }
    return {
      value: dynamicValue("queryParams"),
      trace: ["NewExpression(URLSearchParams)", "DynamicQuery"],
    };
  }

  if (calleePath.isIdentifier({ name: "URL" })) {
    const urlArg = getArgumentExpressionPath(path, 0);
    if (!urlArg) {
      return {
        value: unknownValue("url-constructor-arg"),
        trace: ["NewExpression(URL)", "MissingUrlArg"],
      };
    }

    const urlResolved = resolveExpression(urlArg, nextState(state));
    const baseArg = getArgumentExpressionPath(path, 1);
    if (!baseArg) {
      return {
        value: urlResolved.value,
        trace: ["NewExpression(URL)", ...urlResolved.trace],
      };
    }

    const baseResolved = resolveExpression(baseArg, nextState(state));
    if (baseResolved.value.kind === "literal" && urlResolved.value.kind === "literal") {
      try {
        const value = new URL(urlResolved.value.value, baseResolved.value.value).toString();
        return {
          value: literalValue(value),
          trace: [
            "NewExpression(URL)",
            ...baseResolved.trace,
            ...urlResolved.trace,
            "URLConstructorJoin",
          ],
        };
      } catch {
        return {
          value: joinBaseAndPath(baseResolved.value, urlResolved.value),
          trace: [
            "NewExpression(URL)",
            ...baseResolved.trace,
            ...urlResolved.trace,
            "FallbackJoin",
          ],
        };
      }
    }

    return {
      value: joinBaseAndPath(baseResolved.value, urlResolved.value),
      trace: [
        "NewExpression(URL)",
        ...baseResolved.trace,
        ...urlResolved.trace,
        "FallbackJoin",
      ],
    };
  }

  if (calleePath.isIdentifier({ name: "String" })) {
    const firstArg = getArgumentExpressionPath(path, 0);
    if (firstArg) {
      return resolveExpression(firstArg, nextState(state));
    }
  }

  if (calleePath.isIdentifier({ name: "Request" })) {
    const urlArg = getArgumentExpressionPath(path, 0);
    if (urlArg) {
      return resolveExpression(urlArg, nextState(state));
    }
  }

  const args = path.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
  if (args.length > 0) {
    const resolvedArgs = args
      .filter((arg): arg is NodePath<t.Expression> => arg.isExpression())
      .map((arg) => resolveExpression(arg, nextState(state)));
    return {
      value: concatValues(resolvedArgs.map((result) => result.value)),
      trace: addTrace(
        `NewExpression(${calleeName ?? "unknown"})`,
        resolvedArgs.map((result) => result.trace),
      ),
    };
  }

  return {
    value: unknownValue(`new:${calleeName ?? "unknown"}`),
    trace: [`NewExpression(${calleeName ?? "unknown"})`, "UnknownConstructor"],
  };
}
