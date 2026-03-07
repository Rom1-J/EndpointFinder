import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { getStaticPropertyName } from "../../utils/ast";
import {
  concatValues,
  literalValue,
  unknownValue,
  type ResolvedValue,
} from "../valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "../types";
import { addTrace, getCallArguments, nextState } from "./state";

export function resolveKnownMemberCall(
  path: NodePath<t.CallExpression>,
  calleePath: NodePath<t.Expression | t.V8IntrinsicIdentifier | t.Super>,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult | null {
  if (!calleePath.isMemberExpression()) {
    return null;
  }

  const method = getStaticPropertyName(calleePath.node);
  if (!method) {
    return null;
  }

  const objectPath = calleePath.get("object");
  if (!objectPath.isExpression()) {
    return null;
  }

  const objectResolved = resolveExpression(objectPath, nextState(state));
  const args = getCallArguments(path);
  const argResolved = args.map((argPath) => {
    if (!argPath.isExpression()) {
      return {
        value: unknownValue("spread-arg"),
        trace: ["SpreadArgument"],
      };
    }
    return resolveExpression(argPath, nextState(state));
  });

  if (method === "concat") {
    const value = concatValues([
      objectResolved.value,
      ...argResolved.map((result) => result.value),
    ]);
    return {
      value,
      trace: addTrace("CallExpression(.concat)", [
        objectResolved.trace,
        ...argResolved.map((result) => result.trace),
      ]),
    };
  }

  if (method === "toString" && argResolved.length === 0) {
    return {
      value: objectResolved.value,
      trace: ["CallExpression(.toString)", ...objectResolved.trace],
    };
  }

  if (method === "bind") {
    if (objectResolved.value.kind === "sinkRef") {
      return {
        value: objectResolved.value,
        trace: ["CallExpression(.bind)", ...objectResolved.trace, "BindSinkAlias"],
      };
    }
    if (objectResolved.value.kind === "callable") {
      return {
        value: objectResolved.value,
        trace: ["CallExpression(.bind)", ...objectResolved.trace, "BindCallable"],
      };
    }
    if (objectResolved.value.kind === "functionRef") {
      return {
        value: objectResolved.value,
        trace: [
          "CallExpression(.bind)",
          ...objectResolved.trace,
          "BindFunctionRef",
        ],
      };
    }
  }

  if (method === "join") {
    const separator = argResolved[0]?.value;
    const separatorLiteral =
      !separator || separator.kind === "literal" ? separator?.value ?? "," : null;
    if (objectResolved.value.kind === "array" && separatorLiteral !== null) {
      const parts: ResolvedValue[] = [];
      const arrayElements = objectResolved.value.elements;
      arrayElements.forEach((element, index) => {
        parts.push(element);
        if (index < arrayElements.length - 1) {
          parts.push(literalValue(separatorLiteral));
        }
      });
      return {
        value: concatValues(parts),
        trace: addTrace("CallExpression(.join)", [
          objectResolved.trace,
          ...argResolved.map((result) => result.trace),
        ]),
      };
    }
  }

  return null;
}
