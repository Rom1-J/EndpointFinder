import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { getObjectProperty, unknownValue } from "../valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "../types";
import { nextState } from "./state";

export function resolveObjectDestructuredBinding(
  path: NodePath<t.Identifier>,
  binding: Binding,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult | null {
  const parentPath = binding.path.parentPath;
  if (!parentPath?.isObjectProperty()) {
    return null;
  }

  const objectPatternPath = parentPath.parentPath;
  if (!objectPatternPath?.isObjectPattern()) {
    return null;
  }

  const variableDeclaratorPath = objectPatternPath.parentPath;
  if (!variableDeclaratorPath?.isVariableDeclarator()) {
    return null;
  }

  const initPath = variableDeclaratorPath.get("init");
  if (!initPath.isExpression()) {
    return null;
  }

  const initResolved = resolveExpression(initPath, nextState(state));

  const keyNode = parentPath.node.key;
  const key =
    t.isIdentifier(keyNode) && !parentPath.node.computed
      ? keyNode.name
      : t.isStringLiteral(keyNode)
        ? keyNode.value
        : null;

  if (!key) {
    return {
      value: unknownValue(`destructure:${path.node.name}`),
      trace: [`Identifier(${path.node.name})`, ...initResolved.trace, "DynamicKey"],
    };
  }

  const selected = getObjectProperty(initResolved.value, key);
  if (selected) {
    return {
      value: selected,
      trace: [
        `Identifier(${path.node.name})`,
        ...initResolved.trace,
        `DestructureProperty(${key})`,
      ],
    };
  }

  const valueNode = parentPath.node.value;
  if (t.isAssignmentPattern(valueNode) && t.isExpression(valueNode.right)) {
    const defaultPath = parentPath.get("value.right") as NodePath<t.Expression>;
    const defaultResolved = resolveExpression(defaultPath, nextState(state));
    return {
      value: defaultResolved.value,
      trace: [
        `Identifier(${path.node.name})`,
        ...initResolved.trace,
        ...defaultResolved.trace,
        `DestructureDefault(${key})`,
      ],
    };
  }

  return {
    value: unknownValue(`destructure-missing:${key}`),
    trace: [
      `Identifier(${path.node.name})`,
      ...initResolved.trace,
      `DestructureMissing(${key})`,
    ],
  };
}
