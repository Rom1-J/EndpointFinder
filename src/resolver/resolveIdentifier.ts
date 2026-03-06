import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
  dynamicValue,
  functionRefValue,
  getObjectProperty,
  unknownValue,
  unionValues,
  type ResolvedValue,
} from "./valueModel";
import type { ResolveExpressionFn, ResolvedResult, ResolverState } from "./types";

function nextState(
  state: ResolverState,
  overrides: Partial<ResolverState> = {},
): ResolverState {
  return {
    ...state,
    ...overrides,
    depth: overrides.depth ?? state.depth + 1,
  };
}

function bindingKey(binding: Binding): string {
  const start = binding.identifier.start ?? 0;
  const end = binding.identifier.end ?? 0;
  return `${binding.identifier.name}:${start}:${end}`;
}

function parameterIndex(
  functionPath: NodePath<t.Function>,
  identifier: t.Identifier,
): number {
  for (let index = 0; index < functionPath.node.params.length; index += 1) {
    const param = functionPath.node.params[index];
    if (t.isIdentifier(param) && param === identifier) {
      return index;
    }
    if (t.isAssignmentPattern(param) && t.isIdentifier(param.left) && param.left === identifier) {
      return index;
    }
  }
  return -1;
}

function mergeTrace(prefix: string, traces: string[][]): string[] {
  const output = [prefix];
  for (const trace of traces) {
    output.push(...trace);
  }
  return output;
}

function resolveParamFromCallSites(
  path: NodePath<t.Identifier>,
  binding: Binding,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult {
  const functionPath = binding.path.findParent((parentPath) =>
    parentPath.isFunction(),
  ) as NodePath<t.Function> | null;
  if (!functionPath) {
    return {
      value: dynamicValue(path.node.name),
      trace: [`Identifier(${path.node.name})`, "ParamWithoutFunction"],
    };
  }

  const index = parameterIndex(functionPath, binding.identifier);
  if (index < 0) {
    return {
      value: dynamicValue(path.node.name),
      trace: [`Identifier(${path.node.name})`, "ParamIndexMissing"],
    };
  }

  const callSites = state.context.callSitesByFunction.get(functionPath.node) ?? [];
  if (callSites.length === 0) {
    return {
      value: dynamicValue(path.node.name),
      trace: [`Identifier(${path.node.name})`, "NoCallSites"],
    };
  }

  const resolvedArgs = callSites.map((callPath) => {
    const argPath = callPath.get(`arguments.${index}`);
    if (!argPath || !argPath.isExpression()) {
      return {
        value: unknownValue(`missing-arg-${index}`),
        trace: ["MissingArgument"],
      };
    }
    return resolveExpression(argPath, nextState(state));
  });

  const values = resolvedArgs.map((result) => result.value);
  const trace = mergeTrace(
    `Identifier(${path.node.name})`,
    resolvedArgs.map((result) => result.trace),
  );

  return {
    value: unionValues(values),
    trace,
  };
}

function resolveVariableBinding(
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

function resolveObjectDestructuredBinding(
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

export function resolveIdentifier(
  path: NodePath<t.Identifier>,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult {
  if (state.depth >= state.context.maxDepth) {
    return {
      value: unknownValue(`depth:${path.node.name}`),
      trace: [`Identifier(${path.node.name})`, "DepthLimit"],
    };
  }

  const binding = path.scope.getBinding(path.node.name);
  if (!binding) {
    return {
      value: dynamicValue(path.node.name),
      trace: [`Identifier(${path.node.name})`, "UnboundDynamic"],
    };
  }

  const envValue = state.env.get(binding.identifier);
  if (envValue) {
    return {
      value: envValue,
      trace: [`Identifier(${path.node.name})`, "ParamBinding"],
    };
  }

  const key = bindingKey(binding);
  if (state.visited.has(key)) {
    return {
      value: unknownValue(`cycle:${path.node.name}`),
      trace: [`Identifier(${path.node.name})`, "CycleGuard"],
    };
  }

  const visited = new Set(state.visited);
  visited.add(key);
  const nestedState = nextState(state, { visited });

  if (binding.kind === "module") {
    return {
      value: unknownValue(`import:${path.node.name}`),
      trace: [`Identifier(${path.node.name})`, "ImportBinding"],
    };
  }

  if (binding.kind === "param") {
    return resolveParamFromCallSites(path, binding, nestedState, resolveExpression);
  }

  if (
    binding.path.isVariableDeclarator() ||
    binding.path.isAssignmentExpression() ||
    binding.path.isUpdateExpression()
  ) {
    return resolveVariableBinding(path, binding, nestedState, resolveExpression);
  }

  const destructured = resolveObjectDestructuredBinding(
    path,
    binding,
    nestedState,
    resolveExpression,
  );
  if (destructured) {
    return destructured;
  }

  if (
    binding.path.isFunctionDeclaration() ||
    binding.path.isFunctionExpression() ||
    binding.path.isArrowFunctionExpression()
  ) {
    return {
      value: functionRefValue(binding.path.node, `binding:${path.node.name}`),
      trace: [`Identifier(${path.node.name})`, "FunctionBinding"],
    };
  }

  return {
    value: unknownValue(`binding:${binding.kind}`),
    trace: [`Identifier(${path.node.name})`, `Binding(${binding.kind})`],
  };
}
