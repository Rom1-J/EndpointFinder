import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
  dynamicValue,
  getObjectProperty,
  unknownValue,
  unionValues,
  type ResolvedValue,
} from "../valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "../types";
import { mergeTrace, nextState } from "./state";

export function resolveVariableBinding(
  path: NodePath<t.Identifier>,
  binding: Binding,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult {
  const values: ResolvedValue[] = [];
  const traces: string[][] = [];

  if (binding.path.isVariableDeclarator()) {
    let handledFromObjectPattern = false;

    const idPath = binding.path.get("id");
    if (idPath.isObjectPattern()) {
      const initPath = binding.path.get("init");
      if (initPath.isExpression()) {
        const initResolved = resolveExpression(initPath, nextState(state));

        for (const propPath of idPath.get("properties")) {
          if (!propPath.isObjectProperty()) {
            continue;
          }

          const valuePath = propPath.get("value");
          const isMatch =
            (valuePath.isIdentifier() && valuePath.node === binding.identifier) ||
            (valuePath.isAssignmentPattern() &&
              valuePath.get("left").isIdentifier() &&
              valuePath.get("left").node === binding.identifier);
          if (!isMatch) {
            continue;
          }

          const keyNode = propPath.node.key;
          const key =
            t.isIdentifier(keyNode) && !propPath.node.computed
              ? keyNode.name
              : t.isStringLiteral(keyNode)
                ? keyNode.value
                : null;
          if (!key) {
            values.push(unknownValue(`destructure:${path.node.name}`));
            traces.push([...initResolved.trace, "DestructureDynamicKey"]);
            handledFromObjectPattern = true;
            break;
          }

          const selected = getObjectProperty(initResolved.value, key);
          if (selected) {
            values.push(selected);
            traces.push([...initResolved.trace, `DestructureProperty(${key})`]);
            handledFromObjectPattern = true;
            break;
          }

          if (valuePath.isAssignmentPattern()) {
            const defaultPath = valuePath.get("right");
            if (defaultPath.isExpression()) {
              const defaultResolved = resolveExpression(defaultPath, nextState(state));
              values.push(defaultResolved.value);
              traces.push([
                ...initResolved.trace,
                ...defaultResolved.trace,
                `DestructureDefault(${key})`,
              ]);
              handledFromObjectPattern = true;
              break;
            }
          }

          values.push(unknownValue(`destructure-missing:${key}`));
          traces.push([...initResolved.trace, `DestructureMissing(${key})`]);
          handledFromObjectPattern = true;
          break;
        }
      }
    }

    if (!handledFromObjectPattern) {
      const initPath = binding.path.get("init");
      if (initPath.isExpression()) {
        const resolvedInit = resolveExpression(initPath, nextState(state));
        values.push(resolvedInit.value);
        traces.push(resolvedInit.trace);
      }
    }
  }

  for (const violation of binding.constantViolations) {
    if (violation.isAssignmentExpression()) {
      const rightPath = violation.get("right");
      if (rightPath.isExpression()) {
        const resolved = resolveExpression(rightPath, nextState(state));
        values.push(resolved.value);
        traces.push(resolved.trace);
      }
      continue;
    }

    if (violation.isUpdateExpression()) {
      values.push(dynamicValue(path.node.name));
      traces.push(["UpdateExpression"]);
      continue;
    }

    values.push(unknownValue("complex-mutation"));
    traces.push([`Mutation(${violation.node.type})`]);
  }

  if (values.length === 0) {
    return {
      value: unknownValue(`uninitialized:${path.node.name}`),
      trace: [`Identifier(${path.node.name})`, "NoInitializer"],
    };
  }

  return {
    value: unionValues(values),
    trace: mergeTrace(`Identifier(${path.node.name})`, traces),
  };
}
