import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { expressionToPath, getStaticPropertyName } from "../utils/ast";
import {
  axiosInstanceValue,
  callableValue,
  concatValues,
  dynamicValue,
  functionRefValue,
  getObjectProperty,
  joinBaseAndPath,
  literalValue,
  objectValue,
  unknownValue,
  unionValues,
  xhrInstanceValue,
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

function addTrace(prefix: string, parts: string[][]): string[] {
  const trace = [prefix];
  for (const part of parts) {
    trace.push(...part);
  }
  return trace;
}

function getCallArguments(path: NodePath<t.CallExpression>) {
  return path.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
}

function getArgumentExpressionPath(
  path: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  index: number,
): NodePath<t.Expression> | null {
  const args = path.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
  const argPath = args[index];
  if (!argPath || !argPath.isExpression()) {
    return null;
  }
  return argPath as NodePath<t.Expression>;
}

function getParamBindingIdentifier(
  functionPath: NodePath<t.Function>,
  param: t.Function["params"][number],
): t.Identifier | null {
  if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
    const binding = functionPath.scope.getBinding(param.argument.name);
    return binding?.identifier ?? param.argument;
  }
  if (t.isIdentifier(param)) {
    const binding = functionPath.scope.getBinding(param.name);
    return binding?.identifier ?? param;
  }
  if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
    const binding = functionPath.scope.getBinding(param.left.name);
    return binding?.identifier ?? param.left;
  }
  return null;
}

function collectReturnExpressions(
  functionPath: NodePath<t.Function>,
): NodePath<t.Expression>[] {
  if (
    functionPath.isArrowFunctionExpression() &&
    functionPath.get("body").isExpression()
  ) {
    return [functionPath.get("body") as NodePath<t.Expression>];
  }

  const output: NodePath<t.Expression>[] = [];
  const bodyPath = functionPath.get("body");
  if (!bodyPath.isBlockStatement()) {
    return output;
  }

  bodyPath.traverse({
    Function(innerPath) {
      innerPath.skip();
    },
    ReturnStatement(returnPath) {
      const argPath = returnPath.get("argument");
      if (argPath.isExpression()) {
        output.push(argPath);
      }
    },
  });

  return output;
}

function unwrapCalleePath(
  calleePath: NodePath<t.Expression | t.V8IntrinsicIdentifier | t.Super>,
): NodePath<t.Expression | t.V8IntrinsicIdentifier | t.Super> {
  let current = calleePath;

  while (true) {
    if (current.isSequenceExpression()) {
      const expressions = current.get("expressions");
      const last = expressions[expressions.length - 1];
      if (!last || !last.isExpression()) {
        return current;
      }
      current = last as NodePath<t.Expression>;
      continue;
    }

    if (
      current.isTSAsExpression() ||
      current.isTSTypeAssertion() ||
      current.isTSNonNullExpression()
    ) {
      const expression = current.get("expression") as NodePath<t.Expression>;
      if (!expression.isExpression()) {
        return current;
      }
      current = expression as NodePath<t.Expression>;
      continue;
    }

    return current;
  }
}

function getLiteralModuleId(
  argPath: NodePath<t.Expression> | null,
): string | null {
  if (!argPath) {
    return null;
  }
  if (argPath.isNumericLiteral()) {
    return String(argPath.node.value);
  }
  if (argPath.isStringLiteral()) {
    return argPath.node.value;
  }
  return null;
}

function resolveWebpackRequireCall(
  path: NodePath<t.CallExpression>,
  calleePath: NodePath<t.Expression | t.V8IntrinsicIdentifier | t.Super>,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult | null {
  if (!calleePath.isIdentifier()) {
    return null;
  }

  const binding = calleePath.scope.getBinding(calleePath.node.name);
  if (!binding || binding.kind !== "param") {
    return null;
  }

  const ownerFunctionPath = binding.path.findParent((parentPath) =>
    parentPath.isFunction(),
  ) as NodePath<t.Function> | null;
  if (!ownerFunctionPath) {
    return null;
  }

  const ownerModule = state.context.webpackModuleByFunction.get(ownerFunctionPath.node);
  if (!ownerModule || ownerModule.requireParamName !== calleePath.node.name) {
    return null;
  }

  const moduleId = getLiteralModuleId(getArgumentExpressionPath(path, 0));
  if (!moduleId) {
    return null;
  }

  const requiredModule = state.context.webpackModulesById.get(moduleId);
  if (!requiredModule) {
    const externalModule = state.context.webpackExternalModulesById.get(moduleId);
    if (!externalModule) {
      return null;
    }
    return {
      value: objectValue(externalModule),
      trace: [`CallExpression(require:${moduleId})`, "ExternalWebpackModule"],
    };
  }

  const properties: Record<string, ResolvedValue> = {};
  const traces: string[][] = [];

  for (const [exportName, localName] of requiredModule.exports) {
    const localBinding = requiredModule.functionPath.scope.getBinding(localName);
    if (!localBinding) {
      properties[exportName] = unknownValue(`webpack-export:${moduleId}.${exportName}`);
      traces.push([`WebpackExportMissing(${moduleId}.${exportName})`]);
      continue;
    }

    if (
      localBinding.path.isFunctionDeclaration() ||
      localBinding.path.isFunctionExpression() ||
      localBinding.path.isArrowFunctionExpression()
    ) {
      const returnExpressions = collectReturnExpressions(
        localBinding.path as NodePath<t.Function>,
      );
      if (returnExpressions.length === 1) {
        const resolvedReturn = resolveExpression(returnExpressions[0], nextState(state));
        properties[exportName] = callableValue(
          resolvedReturn.value,
          `webpack:${moduleId}.${exportName}`,
        );
        traces.push([
          `WebpackExport(${moduleId}.${exportName})`,
          ...resolvedReturn.trace,
        ]);
      } else {
        properties[exportName] = functionRefValue(
          localBinding.path.node,
          `webpack:${moduleId}.${exportName}`,
        );
        traces.push([`WebpackExport(${moduleId}.${exportName})`]);
      }
      continue;
    }

    if (localBinding.path.isVariableDeclarator()) {
      const initPath = localBinding.path.get("init");
      if (initPath.isExpression()) {
        const resolved = resolveExpression(initPath, nextState(state));
        properties[exportName] = resolved.value;
        traces.push([`WebpackExport(${moduleId}.${exportName})`, ...resolved.trace]);
        continue;
      }
    }

    properties[exportName] = unknownValue(`webpack-export:${moduleId}.${exportName}`);
    traces.push([`WebpackExportUnknown(${moduleId}.${exportName})`]);
  }

  return {
    value: objectValue(properties),
    trace: addTrace(`CallExpression(require:${moduleId})`, traces),
  };
}

function resolveKnownMemberCall(
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
        trace: ["CallExpression(.bind)", ...objectResolved.trace, "BindFunctionRef"],
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

function invokeFunctionPath(
  functionPath: NodePath<t.Function>,
  args: NodePath<t.Expression | t.SpreadElement>[],
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
  callLabel: string,
  calleeTrace: string[] = [],
): ResolvedResult {
  const fnId = `fn:${functionPath.node.start ?? 0}:${functionPath.node.end ?? 0}`;
  if (state.visited.has(fnId)) {
    return {
      value: unknownValue(`recursive:${callLabel}`),
      trace: [`CallExpression(${callLabel})`, "RecursiveGuard", ...calleeTrace],
    };
  }

  const nextVisited = new Set(state.visited);
  nextVisited.add(fnId);

  const argResolved = args.map((argPath) => {
    if (!argPath.isExpression()) {
      return {
        value: unknownValue("spread-arg"),
        trace: ["SpreadArgument"],
      };
    }
    return resolveExpression(argPath, nextState(state, { visited: nextVisited }));
  });

  const localEnv = new Map(state.env);
  functionPath.node.params.forEach((param, index) => {
    const bindingIdentifier = getParamBindingIdentifier(functionPath, param);
    if (!bindingIdentifier) {
      return;
    }

    const resolvedArg = argResolved[index]?.value;
    if (resolvedArg) {
      localEnv.set(bindingIdentifier, resolvedArg);
      return;
    }

    if (t.isAssignmentPattern(param) && t.isExpression(param.right)) {
      const defaultPath =
        functionPath.get(`params.${index}.right`) as NodePath<t.Expression>;
      const defaultResolved = resolveExpression(
        defaultPath,
        nextState(state, { visited: nextVisited, env: localEnv }),
      );
      localEnv.set(bindingIdentifier, defaultResolved.value);
      return;
    }

    localEnv.set(bindingIdentifier, unknownValue(`missing-arg-${index}`));
  });

  const returnExpressions = collectReturnExpressions(functionPath);
  if (returnExpressions.length === 0) {
    return {
      value: unknownValue(`no-return:${callLabel}`),
      trace: [`CallExpression(${callLabel})`, ...calleeTrace, "NoReturn"],
    };
  }

  const returnResolved = returnExpressions.map((returnPath) =>
    resolveExpression(
      returnPath,
      nextState(state, {
        env: localEnv,
        visited: nextVisited,
      }),
    ),
  );

  return {
    value: unionValues(returnResolved.map((result) => result.value)),
    trace: addTrace(`CallExpression(${callLabel})`, [
      calleeTrace,
      ...argResolved.map((result) => result.trace),
      ...returnResolved.map((result) => result.trace),
    ]),
  };
}

export function getFunctionPathFromCallee(
  calleePath: NodePath<t.Expression | t.V8IntrinsicIdentifier | t.Super>,
): NodePath<t.Function> | null {
  if (calleePath.isFunctionExpression() || calleePath.isArrowFunctionExpression()) {
    return calleePath as NodePath<t.Function>;
  }

  if (!calleePath.isIdentifier()) {
    return null;
  }

  const binding = calleePath.scope.getBinding(calleePath.node.name);
  if (!binding) {
    return null;
  }

  if (binding.path.isFunctionDeclaration()) {
    return binding.path as NodePath<t.Function>;
  }

  if (
    binding.path.isFunctionExpression() ||
    binding.path.isArrowFunctionExpression()
  ) {
    return binding.path as NodePath<t.Function>;
  }

  if (binding.path.isVariableDeclarator()) {
    const initPath = binding.path.get("init");
    if (initPath.isFunctionExpression() || initPath.isArrowFunctionExpression()) {
      return initPath as NodePath<t.Function>;
    }
  }

  return null;
}

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
