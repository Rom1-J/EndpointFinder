import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { ResolvedResult } from "../../../resolver/types";
import type { ResolvedValue } from "../../../resolver/valueModel";

export type ResolveFn = (path: NodePath<t.Expression>) => ResolvedResult;

export interface ResolvedArg {
  path: NodePath<t.Expression>;
  value: ResolvedValue;
}

export function getArgumentExpressionPath(
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

export function resolveArg(
  path: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  index: number,
  resolve: ResolveFn,
): ResolvedArg | null {
  const expressionPath = getArgumentExpressionPath(path, index);
  if (!expressionPath) {
    return null;
  }
  return {
    path: expressionPath,
    value: resolve(expressionPath).value,
  };
}

export function firstDefined<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

export function getObjectPropertyExpression(
  objectPath: NodePath<t.Expression> | null,
  propertyName: string,
): NodePath<t.Expression> | null {
  if (!objectPath || !objectPath.isObjectExpression()) {
    return null;
  }

  for (const propertyPath of objectPath.get("properties")) {
    if (!propertyPath.isObjectProperty()) {
      continue;
    }
    const keyNode = propertyPath.node.key;
    const key =
      t.isIdentifier(keyNode) && !propertyPath.node.computed
        ? keyNode.name
        : t.isStringLiteral(keyNode)
          ? keyNode.value
          : null;
    if (key !== propertyName) {
      continue;
    }

    const valuePath = propertyPath.get("value");
    if (!valuePath.isExpression()) {
      return null;
    }
    return valuePath as NodePath<t.Expression>;
  }

  return null;
}
