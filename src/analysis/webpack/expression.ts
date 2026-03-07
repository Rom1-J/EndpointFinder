import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
  arrayValue,
  callableValue,
  concatValues,
  getObjectProperty,
  literalValue,
  objectValue,
  type ResolvedValue,
  unionValues,
  unknownValue,
} from "../../resolver/valueModel";

export function propertyKeyToString(
  propertyPath: NodePath<t.ObjectProperty | t.ObjectMethod>,
): string | null {
  const keyNode = propertyPath.node.key;
  if (t.isIdentifier(keyNode) && !propertyPath.node.computed) {
    return keyNode.name;
  }
  if (t.isStringLiteral(keyNode)) {
    return keyNode.value;
  }
  if (t.isNumericLiteral(keyNode)) {
    return String(keyNode.value);
  }
  return null;
}

export function extractReturnExpressions(
  functionPath:
    | NodePath<t.Function>
    | NodePath<t.FunctionExpression>
    | NodePath<t.ArrowFunctionExpression>
    | NodePath<t.ObjectMethod>,
): NodePath<t.Expression>[] {
  if (functionPath.isArrowFunctionExpression()) {
    const bodyPath = functionPath.get("body") as NodePath<
      t.Expression | t.BlockStatement
    >;
    if (bodyPath.isExpression() && !bodyPath.isBlockStatement()) {
      return [bodyPath as NodePath<t.Expression>];
    }
  }

  const bodyPath = functionPath.get("body") as NodePath<t.BlockStatement>;
  if (!bodyPath.isBlockStatement()) {
    return [];
  }

  const results: NodePath<t.Expression>[] = [];
  for (const statementPath of bodyPath.get("body")) {
    if (!statementPath.isReturnStatement()) {
      continue;
    }
    const argPath = statementPath.get("argument");
    if (argPath.isExpression()) {
      results.push(argPath as NodePath<t.Expression>);
    }
  }
  return results;
}

export function resolveSimpleExpression(
  expressionPath: NodePath<t.Expression>,
  depth = 0,
  visited = new Set<string>(),
): ResolvedValue {
  if (depth > 12) {
    return unknownValue("external-depth-limit");
  }

  if (expressionPath.isStringLiteral()) {
    return literalValue(expressionPath.node.value);
  }
  if (expressionPath.isNumericLiteral()) {
    return literalValue(String(expressionPath.node.value));
  }
  if (expressionPath.isBooleanLiteral()) {
    return literalValue(String(expressionPath.node.value));
  }
  if (expressionPath.isNullLiteral()) {
    return literalValue("null");
  }

  if (expressionPath.isTemplateLiteral()) {
    const parts: ResolvedValue[] = [];
    const expressionParts = expressionPath.get("expressions");

    for (let index = 0; index < expressionPath.node.quasis.length; index += 1) {
      const quasi = expressionPath.node.quasis[index];
      if (quasi.value.cooked) {
        parts.push(literalValue(quasi.value.cooked));
      }
      const dynamicPart = expressionParts[index];
      if (dynamicPart && dynamicPart.isExpression()) {
        parts.push(resolveSimpleExpression(dynamicPart, depth + 1, visited));
      }
    }

    return concatValues(parts);
  }

  if (expressionPath.isBinaryExpression({ operator: "+" })) {
    const left = resolveSimpleExpression(
      expressionPath.get("left") as NodePath<t.Expression>,
      depth + 1,
      visited,
    );
    const right = resolveSimpleExpression(
      expressionPath.get("right") as NodePath<t.Expression>,
      depth + 1,
      visited,
    );
    return concatValues([left, right]);
  }

  if (expressionPath.isObjectExpression()) {
    const properties: Record<string, ResolvedValue> = {};
    for (const propPath of expressionPath.get("properties")) {
      if (!propPath.isObjectProperty() && !propPath.isObjectMethod()) {
        continue;
      }

      const key = propertyKeyToString(
        propPath as NodePath<t.ObjectProperty | t.ObjectMethod>,
      );
      if (!key) {
        continue;
      }

      if (propPath.isObjectMethod()) {
        const returns = extractReturnExpressions(propPath);
        if (returns.length === 1) {
          properties[key] = callableValue(
            resolveSimpleExpression(returns[0], depth + 1, visited),
            `externalMethod:${key}`,
          );
        }
        continue;
      }

      const valuePath = propPath.get("value");
      if (!valuePath.isExpression()) {
        continue;
      }
      properties[key] = resolveSimpleExpression(valuePath, depth + 1, visited);
    }
    return objectValue(properties);
  }

  if (expressionPath.isArrayExpression()) {
    const elements = expressionPath
      .get("elements")
      .map((elementPath) => {
        if (!elementPath || !elementPath.isExpression()) {
          return unknownValue("array-hole");
        }
        return resolveSimpleExpression(elementPath, depth + 1, visited);
      });
    return arrayValue(elements);
  }

  if (expressionPath.isIdentifier()) {
    const binding = expressionPath.scope.getBinding(expressionPath.node.name);
    if (!binding) {
      return unknownValue(`unbound:${expressionPath.node.name}`);
    }

    const key = `${binding.identifier.name}:${binding.identifier.start ?? 0}:${binding.identifier.end ?? 0}`;
    if (visited.has(key)) {
      return unknownValue(`cycle:${expressionPath.node.name}`);
    }
    const nextVisited = new Set(visited);
    nextVisited.add(key);

    if (binding.path.isVariableDeclarator()) {
      const initPath = binding.path.get("init");
      if (initPath.isExpression()) {
        return resolveSimpleExpression(initPath, depth + 1, nextVisited);
      }
    }

    if (
      binding.path.isFunctionDeclaration() ||
      binding.path.isFunctionExpression() ||
      binding.path.isArrowFunctionExpression()
    ) {
      const returns = extractReturnExpressions(binding.path as NodePath<t.Function>);
      if (returns.length === 1) {
        return callableValue(
          resolveSimpleExpression(returns[0], depth + 1, nextVisited),
          `externalFn:${expressionPath.node.name}`,
        );
      }
      return unknownValue(`function:${expressionPath.node.name}`);
    }

    return unknownValue(`binding:${binding.kind}`);
  }

  if (expressionPath.isMemberExpression()) {
    const objectPath = expressionPath.get("object");
    if (!objectPath.isExpression()) {
      return unknownValue("member-object");
    }
    const objectResolved = resolveSimpleExpression(objectPath, depth + 1, visited);
    const keyNode = expressionPath.node.property;
    const key =
      t.isIdentifier(keyNode) && !expressionPath.node.computed
        ? keyNode.name
        : t.isStringLiteral(keyNode)
          ? keyNode.value
          : null;
    if (!key) {
      return unknownValue("member-key");
    }
    return getObjectProperty(objectResolved, key) ?? unknownValue(`member:${key}`);
  }

  if (expressionPath.isCallExpression()) {
    const calleePath = expressionPath.get("callee");
    if (calleePath.isMemberExpression()) {
      const keyNode = calleePath.node.property;
      const method =
        t.isIdentifier(keyNode) && !calleePath.node.computed
          ? keyNode.name
          : t.isStringLiteral(keyNode)
            ? keyNode.value
            : null;
      if (method === "concat") {
        const objectPath = calleePath.get("object");
        if (!objectPath.isExpression()) {
          return unknownValue("concat-object");
        }
        const objectValueResolved = resolveSimpleExpression(
          objectPath,
          depth + 1,
          visited,
        );
        const args = (expressionPath.get("arguments") as NodePath<
          t.Expression | t.SpreadElement
        >[])
          .map((argPath) => {
            if (!argPath.isExpression()) {
              return unknownValue("spread-arg");
            }
            return resolveSimpleExpression(argPath, depth + 1, visited);
          });
        return concatValues([objectValueResolved, ...args]);
      }
    }

    const calleeResolved = calleePath.isExpression()
      ? resolveSimpleExpression(calleePath, depth + 1, visited)
      : unknownValue("callee");
    if (calleeResolved.kind === "callable") {
      return calleeResolved.returnValue;
    }
    return unknownValue("call");
  }

  if (expressionPath.isSequenceExpression()) {
    const expressions = expressionPath.get("expressions");
    const last = expressions[expressions.length - 1];
    if (!last || !last.isExpression()) {
      return unknownValue("sequence-empty");
    }
    return resolveSimpleExpression(last, depth + 1, visited);
  }

  if (expressionPath.isConditionalExpression()) {
    const left = resolveSimpleExpression(
      expressionPath.get("consequent"),
      depth + 1,
      visited,
    );
    const right = resolveSimpleExpression(
      expressionPath.get("alternate"),
      depth + 1,
      visited,
    );
    return unionValues([left, right]);
  }

  return unknownValue(expressionPath.node.type);
}
