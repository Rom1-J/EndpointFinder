import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import type { ResolvedValue } from "../resolver/valueModel";
import type { ResolvedResult } from "../resolver/types";
import { expressionToPath, getStaticPropertyName } from "../utils/ast";
import type { SinkDefinition } from "./sinkConfig";

export interface SinkMatch {
  definition: SinkDefinition;
  urlArgPath: NodePath<t.Expression> | null;
  baseURLArgPath: NodePath<t.Expression> | null;
  methodArgPath: NodePath<t.Expression> | null;
  baseURL: ResolvedValue | null;
}

export interface MatchSinkContext {
  sinkDefinitions: SinkDefinition[];
  resolveExpression: (path: NodePath<t.Expression>) => ResolvedResult;
}

function getArgumentPath(
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

function getMethodNameFromMatch(match: string): string | null {
  const parts = match.split(".");
  if (parts.length < 2) {
    return null;
  }
  return parts[parts.length - 1];
}

function matchesMethodDefinition(
  definition: SinkDefinition,
  path: NodePath<t.CallExpression>,
  context: MatchSinkContext,
): { matched: boolean; baseURL: ResolvedValue | null } {
  const calleePath = path.get("callee");
  if (!calleePath.isMemberExpression()) {
    return { matched: false, baseURL: null };
  }

  const directPath = expressionToPath(calleePath.node as t.Expression);
  if (directPath === definition.match) {
    return { matched: true, baseURL: null };
  }

  if (
    definition.match === "XMLHttpRequest.open" &&
    directPath === "XMLHttpRequest.prototype.open"
  ) {
    return { matched: true, baseURL: null };
  }

  const methodName = getMethodNameFromMatch(definition.match);
  const propertyName = getStaticPropertyName(calleePath.node);
  if (!methodName || methodName !== propertyName) {
    return { matched: false, baseURL: null };
  }

  if (definition.match.startsWith("axios.")) {
    const objectPath = calleePath.get("object");
    if (!objectPath.isExpression()) {
      return { matched: false, baseURL: null };
    }
    const resolved = context.resolveExpression(objectPath);
    if (resolved.value.kind === "axiosInstance") {
      return {
        matched: true,
        baseURL: resolved.value.baseURL,
      };
    }
  }

  if (definition.match === "XMLHttpRequest.open") {
    const objectPath = calleePath.get("object");
    if (!objectPath.isExpression()) {
      return { matched: false, baseURL: null };
    }
    const resolved = context.resolveExpression(objectPath);
    if (resolved.value.kind === "xhrInstance") {
      return { matched: true, baseURL: null };
    }
  }

  return { matched: false, baseURL: null };
}

export function matchSink(
  path: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  context: MatchSinkContext,
): SinkMatch | null {
  const calleePath = path.get("callee") as NodePath<
    t.Expression | t.V8IntrinsicIdentifier | t.Super
  >;
  if (!calleePath || !calleePath.isExpression()) {
    return null;
  }
  const calleeName = expressionToPath(calleePath.node);

  for (const definition of context.sinkDefinitions) {
    if (definition.type === "call") {
      if (!path.isCallExpression()) {
        continue;
      }
      if (calleeName !== definition.match) {
        continue;
      }
      return {
        definition,
        urlArgPath: getArgumentPath(path, definition.urlArg),
        baseURLArgPath:
          typeof definition.baseURLArg === "number"
            ? getArgumentPath(path, definition.baseURLArg)
            : null,
        methodArgPath:
          typeof definition.methodArg === "number"
            ? getArgumentPath(path, definition.methodArg)
            : null,
        baseURL: null,
      };
    }

    if (definition.type === "constructor") {
      if (!path.isNewExpression()) {
        continue;
      }
      if (calleeName !== definition.match) {
        continue;
      }
      return {
        definition,
        urlArgPath: getArgumentPath(path, definition.urlArg),
        baseURLArgPath:
          typeof definition.baseURLArg === "number"
            ? getArgumentPath(path, definition.baseURLArg)
            : null,
        methodArgPath:
          typeof definition.methodArg === "number"
            ? getArgumentPath(path, definition.methodArg)
            : null,
        baseURL: null,
      };
    }

    if (definition.type === "method") {
      if (!path.isCallExpression()) {
        continue;
      }
      const methodMatch = matchesMethodDefinition(definition, path, context);
      if (!methodMatch.matched) {
        continue;
      }
      return {
        definition,
        urlArgPath: getArgumentPath(path, definition.urlArg),
        baseURLArgPath:
          typeof definition.baseURLArg === "number"
            ? getArgumentPath(path, definition.baseURLArg)
            : null,
        methodArgPath:
          typeof definition.methodArg === "number"
            ? getArgumentPath(path, definition.methodArg)
            : null,
        baseURL: methodMatch.baseURL,
      };
    }
  }

  return null;
}
