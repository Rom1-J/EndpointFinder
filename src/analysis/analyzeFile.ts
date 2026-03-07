import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import {
  TraceMap,
  generatedPositionFor,
} from "@jridgewell/trace-mapping";
import { parseCode, parseFile } from "../parser/parseFile";
import { renderValue } from "../resolver/renderValue";
import { resolveExpression } from "../resolver/resolveExpression";
import { getFunctionPathFromCallee } from "../resolver/resolveCall";
import type {
  ResolverContext,
  ResolverState,
  WebpackModuleInfo,
} from "../resolver/types";
import {
  objectValue,
  sinkRefValue,
  getObjectProperty,
  joinBaseAndPath,
  isSinkRefValue,
  unionValues,
  unknownValue,
  type ResolvedValue,
  type SinkRefValue,
} from "../resolver/valueModel";
import { builtinSinks } from "../sinks/builtinSinks";
import { matchSink } from "../sinks/matchSink";
import type { SinkDefinition } from "../sinks/sinkConfig";
import type {
  AnalyzeFileResult,
  Finding,
  FindingBody,
  FindingHeader,
} from "../types";
import {
  dedupeTrace,
  expressionToPath,
  normalizeFilePath,
} from "../utils/ast";

export interface AnalyzeSourceOptions {
  sinkDefinitions?: SinkDefinition[];
  includeUnresolved?: boolean;
  maxDepth?: number;
  webpackExternalModulesById?: Map<string, Record<string, ResolvedValue>>;
}

function resolveWithState(
  expressionPath: NodePath<t.Expression>,
  context: ResolverContext,
) {
  const initialState: ResolverState = {
    context,
    env: new Map(),
    visited: new Set(),
    depth: 0,
  };
  return resolveExpression(expressionPath, initialState);
}

function toHttpMethod(value: ResolvedValue | undefined): string | null {
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

function propertyKeyToString(
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

function extractReturnIdentifierFromFunction(
  functionPath:
    | NodePath<t.FunctionExpression>
    | NodePath<t.ArrowFunctionExpression>
    | NodePath<t.ObjectMethod>,
): string | null {
  if (functionPath.isArrowFunctionExpression()) {
    const arrowBodyPath = functionPath.get("body") as NodePath<
      t.Expression | t.BlockStatement
    >;
    if (arrowBodyPath.isIdentifier()) {
      return arrowBodyPath.node.name;
    }
    if (!arrowBodyPath.isBlockStatement()) {
      return null;
    }

    const bodyStatements = arrowBodyPath.get("body");
    for (const statementPath of bodyStatements) {
      if (!statementPath.isReturnStatement()) {
        continue;
      }
      const argumentPath = statementPath.get("argument");
      if (argumentPath.isIdentifier()) {
        return argumentPath.node.name;
      }
    }

    return null;
  }

  const bodyPath = functionPath.get("body") as NodePath<t.BlockStatement>;

  const bodyStatements = bodyPath.get("body");
  for (const statementPath of bodyStatements) {
    if (!statementPath.isReturnStatement()) {
      continue;
    }
    const argumentPath = statementPath.get("argument");
    if (argumentPath.isIdentifier()) {
      return argumentPath.node.name;
    }
  }

  return null;
}

function readWebpackModuleInfo(
  moduleId: string,
  moduleFunctionPath: NodePath<t.Function>,
): WebpackModuleInfo {
  const exports = new Map<string, string>();
  const params = moduleFunctionPath.node.params;

  const exportsParamName =
    params[1] && t.isIdentifier(params[1]) ? params[1].name : null;
  const requireParamName =
    params[2] && t.isIdentifier(params[2]) ? params[2].name : null;

  if (exportsParamName && requireParamName) {
    moduleFunctionPath.traverse({
      Function(innerPath) {
        if (innerPath.node !== moduleFunctionPath.node) {
          innerPath.skip();
        }
      },
      CallExpression(callPath) {
        const calleePath = callPath.get("callee");
        if (!calleePath.isMemberExpression()) {
          return;
        }
        const objectPath = calleePath.get("object");
        if (!objectPath.isIdentifier({ name: requireParamName })) {
          return;
        }
        const propertyPath = calleePath.get("property");
        if (!propertyPath.isIdentifier({ name: "d" })) {
          return;
        }

        const firstArg = getArgumentExpressionPath(callPath, 0);
        if (!firstArg || !firstArg.isIdentifier({ name: exportsParamName })) {
          return;
        }

        const secondArg = getArgumentExpressionPath(callPath, 1);
        if (!secondArg || !secondArg.isObjectExpression()) {
          return;
        }

        for (const propPath of secondArg.get("properties")) {
          if (!propPath.isObjectProperty() && !propPath.isObjectMethod()) {
            continue;
          }

          const exportName = propertyKeyToString(
            propPath as NodePath<t.ObjectProperty | t.ObjectMethod>,
          );
          if (!exportName) {
            continue;
          }

          if (propPath.isObjectMethod()) {
            const targetName = extractReturnIdentifierFromFunction(propPath);
            if (targetName) {
              exports.set(exportName, targetName);
            }
            continue;
          }

          const valuePath = propPath.get("value");
          if (
            valuePath.isFunctionExpression() ||
            valuePath.isArrowFunctionExpression()
          ) {
            const targetName = extractReturnIdentifierFromFunction(valuePath);
            if (targetName) {
              exports.set(exportName, targetName);
            }
          }
        }
      },
    });
  }

  return {
    id: moduleId,
    functionPath: moduleFunctionPath,
    requireParamName,
    exportsParamName,
    exports,
  };
}

function collectResolverIndexes(ast: t.File) {
  const callSitesByFunction = new Map<t.Function, NodePath<t.CallExpression>[]>();
  const functionPaths = new Map<t.Function, NodePath<t.Function>>();
  const webpackModulesById = new Map<string, WebpackModuleInfo>();
  const webpackModuleByFunction = new Map<t.Function, WebpackModuleInfo>();
  const memberAssignments = new Map<string, NodePath<t.Expression>[]>();

  const addMemberAssignment = (key: string, valuePath: NodePath<t.Expression>) => {
    const existing = memberAssignments.get(key);
    if (existing) {
      existing.push(valuePath);
    } else {
      memberAssignments.set(key, [valuePath]);
    }
  };

  traverse(ast, {
    Function(path) {
      functionPaths.set(path.node, path as NodePath<t.Function>);
    },
    AssignmentExpression(path) {
      if (path.node.operator !== "=") {
        return;
      }
      const leftPath = path.get("left");
      if (!leftPath.isMemberExpression()) {
        return;
      }
      const staticPath = expressionToPath(leftPath.node as t.Expression);
      if (!staticPath) {
        return;
      }

      const rightPath = path.get("right");
      if (!rightPath.isExpression()) {
        return;
      }

      addMemberAssignment(staticPath, rightPath as NodePath<t.Expression>);
    },
    CallExpression(path) {
      const functionPath = getFunctionPathFromCallee(
        path.get("callee") as NodePath<t.Expression | t.V8IntrinsicIdentifier | t.Super>,
      );
      if (functionPath) {
        const existing = callSitesByFunction.get(functionPath.node);
        if (existing) {
          existing.push(path);
        } else {
          callSitesByFunction.set(functionPath.node, [path]);
        }
      }

      const args = path.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
      const firstArg = args[0];
      if (!firstArg || !firstArg.isArrayExpression()) {
        return;
      }

      const firstArgElements = firstArg.get("elements");
      const moduleObject = firstArgElements[1];
      if (!moduleObject || !moduleObject.isObjectExpression()) {
        return;
      }

      for (const modulePropPath of moduleObject.get("properties")) {
        if (!modulePropPath.isObjectProperty()) {
          continue;
        }

        const keyNode = modulePropPath.node.key;
        const moduleId =
          t.isNumericLiteral(keyNode)
            ? String(keyNode.value)
            : t.isStringLiteral(keyNode)
              ? keyNode.value
              : t.isIdentifier(keyNode) && !modulePropPath.node.computed
                ? keyNode.name
                : null;
        if (!moduleId) {
          continue;
        }

        const moduleValuePath = modulePropPath.get("value");
        if (!moduleValuePath.isFunctionExpression() && !moduleValuePath.isArrowFunctionExpression()) {
          continue;
        }

        const moduleFunctionPath = moduleValuePath as NodePath<t.Function>;
        const moduleInfo = readWebpackModuleInfo(moduleId, moduleFunctionPath);
        webpackModulesById.set(moduleId, moduleInfo);
        webpackModuleByFunction.set(moduleFunctionPath.node, moduleInfo);
      }
    },
  });

  return {
    callSitesByFunction,
    functionPaths,
    webpackModulesById,
    webpackModuleByFunction,
    memberAssignments,
  };
}

function sinkRefFromDefinition(
  definition: SinkDefinition,
  baseURL: ResolvedValue | null = null,
): SinkRefValue {
  return sinkRefValue({
    sinkName: definition.name,
    match: definition.match,
    sinkType: definition.type,
    urlArg: definition.urlArg,
    methodArg: definition.methodArg,
    httpMethod: definition.httpMethod,
    baseURL,
  });
}

function mergeGlobalSymbolValue(
  symbolMap: Map<string, ResolvedValue>,
  key: string,
  value: ResolvedValue,
) {
  const existing = symbolMap.get(key);
  if (!existing) {
    symbolMap.set(key, value);
    return;
  }
  symbolMap.set(key, unionValues([existing, value]));
}

function ensureObjectValue(value: ResolvedValue | undefined): {
  kind: "object";
  properties: Record<string, ResolvedValue>;
} {
  if (value?.kind === "object") {
    return value;
  }
  return objectValue({});
}

function addMethodSinkToGlobal(
  symbolMap: Map<string, ResolvedValue>,
  definition: SinkDefinition,
) {
  const parts = definition.match.split(".");
  if (parts.length < 2) {
    return;
  }

  // Instance-only sink, not a global static property.
  if (definition.match === "XMLHttpRequest.open") {
    return;
  }

  const root = parts[0];
  let rootValue = ensureObjectValue(symbolMap.get(root));
  mergeGlobalSymbolValue(symbolMap, root, rootValue);

  let current = rootValue;
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    const isLeaf = index === parts.length - 1;

    if (isLeaf) {
      const sinkValue = sinkRefFromDefinition(definition);
      const existing = current.properties[part];
      current.properties[part] = existing
        ? unionValues([existing, sinkValue])
        : sinkValue;
      return;
    }

    const existing = current.properties[part];
    const nextObject = ensureObjectValue(existing);
    current.properties[part] = existing
      ? unionValues([existing, nextObject])
      : nextObject;
    current = nextObject;
  }
}

function buildGlobalSymbolValues(
  sinkDefinitions: SinkDefinition[],
): Map<string, ResolvedValue> {
  const symbols = new Map<string, ResolvedValue>();

  for (const definition of sinkDefinitions) {
    if (definition.type === "call" || definition.type === "constructor") {
      const rootParts = definition.match.split(".");
      if (rootParts.length === 1) {
        mergeGlobalSymbolValue(symbols, definition.match, sinkRefFromDefinition(definition));
      }
    }

    if (definition.type === "method") {
      addMethodSinkToGlobal(symbols, definition);
    }
  }

  return symbols;
}

function collectFunctionRefs(
  value: ResolvedValue,
  output: Set<t.Function>,
): void {
  if (value.kind === "functionRef") {
    output.add(value.functionNode);
    return;
  }
  if (value.kind === "callable") {
    collectFunctionRefs(value.returnValue, output);
    return;
  }
  if (value.kind === "union") {
    value.options.forEach((option) => collectFunctionRefs(option, output));
  }
}

function addCallSiteIfMissing(
  callSitesByFunction: Map<t.Function, NodePath<t.CallExpression>[]>,
  functionNode: t.Function,
  callSite: NodePath<t.CallExpression>,
): boolean {
  const list = callSitesByFunction.get(functionNode);
  if (!list) {
    callSitesByFunction.set(functionNode, [callSite]);
    return true;
  }

  if (list.some((existing) => existing.node === callSite.node)) {
    return false;
  }

  list.push(callSite);
  return true;
}

function augmentIndirectCallSites(ast: t.File, context: ResolverContext): void {
  const maxPasses = 3;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;

    traverse(ast, {
      CallExpression(path) {
        const directFunctionPath = getFunctionPathFromCallee(
          path.get("callee") as NodePath<t.Expression | t.V8IntrinsicIdentifier | t.Super>,
        );
        if (directFunctionPath) {
          return;
        }

        const calleePath = path.get("callee");
        if (!calleePath.isExpression()) {
          return;
        }

        const resolved = resolveWithState(calleePath as NodePath<t.Expression>, context);
        const functionRefs = new Set<t.Function>();
        collectFunctionRefs(resolved.value, functionRefs);

        for (const functionRef of functionRefs) {
          changed =
            addCallSiteIfMissing(context.callSitesByFunction, functionRef, path) ||
            changed;
        }
      },
    });

    if (!changed) {
      break;
    }
  }
}

function toSinkDefinition(ref: SinkRefValue): SinkDefinition {
  return {
    name: ref.sinkName,
    type: ref.sinkType,
    match: ref.match,
    urlArg: ref.urlArg,
    methodArg: ref.methodArg,
    httpMethod: ref.httpMethod,
  };
}

function collectSinkRefs(value: ResolvedValue): SinkRefValue[] {
  if (isSinkRefValue(value)) {
    return [value];
  }
  if (value.kind === "union") {
    const seen = new Map<string, SinkRefValue>();
    for (const option of value.options) {
      for (const sinkRef of collectSinkRefs(option)) {
        const key = `${sinkRef.match}:${sinkRef.sinkType}:${sinkRef.urlArg}:${
          sinkRef.methodArg ?? "none"
        }:${sinkRef.httpMethod ?? "none"}`;
        if (!seen.has(key)) {
          seen.set(key, sinkRef);
        }
      }
    }
    return [...seen.values()];
  }
  return [];
}

function resolveSpreadArgumentValue(value: ResolvedValue): ResolvedValue {
  if (value.kind === "array") {
    return value.elements[0] ?? value;
  }
  if (value.kind === "union") {
    return unionValues(value.options.map((option) => resolveSpreadArgumentValue(option)));
  }
  return value;
}

function resolveCallArgumentByIndex(
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  index: number,
  resolve: (path: NodePath<t.Expression>) => ReturnType<typeof resolveExpression>,
): ReturnType<typeof resolveExpression> | null {
  const args = sinkPath.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
  const argPath = args[index];
  if (!argPath) {
    return null;
  }

  if (argPath.isExpression()) {
    return resolve(argPath as NodePath<t.Expression>);
  }

  if (argPath.isSpreadElement()) {
    const spreadArg = argPath.get("argument");
    if (!spreadArg.isExpression()) {
      return {
        value: unknownValue("spread-argument"),
        trace: ["SpreadArgument", "NoExpression"],
      };
    }
    const spreadResolved = resolve(spreadArg as NodePath<t.Expression>);
    return {
      value: resolveSpreadArgumentValue(spreadResolved.value),
      trace: ["SpreadArgument", ...spreadResolved.trace],
    };
  }

  return null;
}

interface ResolvedSinkTarget {
  definition: SinkDefinition;
  baseURL: ResolvedValue | null;
  indirectTrace: string[];
}

function resolveIndirectSinkTargets(
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  resolve: (path: NodePath<t.Expression>) => ReturnType<typeof resolveExpression>,
): ResolvedSinkTarget[] {
  const calleePath = sinkPath.get("callee") as NodePath<
    t.Expression | t.V8IntrinsicIdentifier | t.Super
  >;
  if (!calleePath.isExpression()) {
    return [];
  }

  const resolvedCallee = resolve(calleePath as NodePath<t.Expression>);
  const sinkRefs = collectSinkRefs(resolvedCallee.value).filter((sinkRef) =>
    sinkPath.isNewExpression()
      ? sinkRef.sinkType === "constructor"
      : sinkRef.sinkType !== "constructor",
  );
  if (sinkRefs.length === 0) {
    return [];
  }

  return sinkRefs.map((sinkRef) => ({
    definition: toSinkDefinition(sinkRef),
    baseURL: sinkRef.baseURL ?? null,
    indirectTrace: [...resolvedCallee.trace, `IndirectSink(${sinkRef.match})`],
  }));
}

function resolveAxiosCall(
  callPath: NodePath<t.CallExpression>,
  resolve: (path: NodePath<t.Expression>) => ReturnType<typeof resolveExpression>,
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

function resolveFetchLikeMethod(
  callPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  resolve: (path: NodePath<t.Expression>) => ReturnType<typeof resolveExpression>,
): string | null {
  const initPath = getArgumentExpressionPath(callPath, 1);
  if (!initPath || !initPath.isExpression()) {
    return null;
  }
  const initResolved = resolve(initPath);
  return methodFromObjectConfig(initResolved.value);
}

function resolveAxiosMethodBaseURL(
  callPath: NodePath<t.CallExpression>,
  resolve: (path: NodePath<t.Expression>) => ReturnType<typeof resolveExpression>,
): ResolvedValue | null {
  const configPath = getArgumentExpressionPath(callPath, 1);
  if (!configPath || !configPath.isExpression()) {
    return null;
  }
  const configResolved = resolve(configPath);
  return getObjectProperty(configResolved.value, "baseURL") ?? null;
}

interface GenericRenderResult {
  text: string;
  hasUnknown: boolean;
  hasDynamic: boolean;
}

function confidenceFromGeneric(rendered: GenericRenderResult): Finding["confidence"] {
  if (!rendered.hasUnknown && !rendered.hasDynamic) {
    return "high";
  }
  if (!rendered.hasUnknown) {
    return "medium";
  }
  return "low";
}

function renderGenericValue(
  value: ResolvedValue,
  mode: "inline" | "json" = "inline",
): GenericRenderResult {
  switch (value.kind) {
    case "literal":
      return {
        text: mode === "json" ? JSON.stringify(value.value) : value.value,
        hasUnknown: false,
        hasDynamic: false,
      };
    case "dynamic":
      return {
        text: `\${${value.label}}`,
        hasUnknown: false,
        hasDynamic: true,
      };
    case "unknown":
      return {
        text: `\${${value.reason}}`,
        hasUnknown: true,
        hasDynamic: false,
      };
    case "concat": {
      const parts = value.parts.map((part) => renderGenericValue(part, "inline"));
      return {
        text: parts.map((part) => part.text).join(""),
        hasUnknown: parts.some((part) => part.hasUnknown),
        hasDynamic: parts.some((part) => part.hasDynamic),
      };
    }
    case "union": {
      const options = value.options.map((option) => renderGenericValue(option, mode));
      const uniqueTexts = [...new Set(options.map((option) => option.text))];
      return {
        text: uniqueTexts.length === 1 ? uniqueTexts[0] : `(${uniqueTexts.join(" | ")})`,
        hasUnknown: options.some((option) => option.hasUnknown),
        hasDynamic: true,
      };
    }
    case "object": {
      const keys = Object.keys(value.properties).sort();
      const renderedEntries = keys.map((key) => ({
        key,
        value: renderGenericValue(value.properties[key], mode === "json" ? "json" : "inline"),
      }));
      const entryText = renderedEntries
        .map((entry) => {
          const renderedKey = mode === "json" ? JSON.stringify(entry.key) : entry.key;
          return `${renderedKey}: ${entry.value.text}`;
        })
        .join(", ");
      return {
        text: `{ ${entryText} }`,
        hasUnknown: renderedEntries.some((entry) => entry.value.hasUnknown),
        hasDynamic: renderedEntries.some((entry) => entry.value.hasDynamic),
      };
    }
    case "array": {
      const renderedElements = value.elements.map((element) =>
        renderGenericValue(element, mode === "json" ? "json" : "inline"),
      );
      return {
        text: `[${renderedElements.map((entry) => entry.text).join(", ")}]`,
        hasUnknown: renderedElements.some((entry) => entry.hasUnknown),
        hasDynamic: renderedElements.some((entry) => entry.hasDynamic),
      };
    }
    case "functionRef":
      return {
        text: "${function}",
        hasUnknown: true,
        hasDynamic: false,
      };
    case "callable":
      return renderGenericValue(value.returnValue, mode);
    case "sinkRef":
      return {
        text: `${value.match}()`,
        hasUnknown: false,
        hasDynamic: true,
      };
    case "axiosInstance":
      return {
        text: "${axiosInstance}",
        hasUnknown: true,
        hasDynamic: false,
      };
    case "xhrInstance":
      return {
        text: "${xhrInstance}",
        hasUnknown: true,
        hasDynamic: false,
      };
    default:
      return {
        text: "${unknown}",
        hasUnknown: true,
        hasDynamic: false,
      };
  }
}

function metadataFromGeneric(rendered: GenericRenderResult): {
  value: string | null;
  valueTemplate: string | null;
  confidence: Finding["confidence"];
} {
  const confidence = confidenceFromGeneric(rendered);
  if (confidence === "high") {
    return {
      value: rendered.text,
      valueTemplate: null,
      confidence,
    };
  }
  return {
    value: null,
    valueTemplate: rendered.text,
    confidence,
  };
}

function renderMetadataValueDetailed(
  value: ResolvedValue,
  mode: "inline" | "json" = "inline",
): {
  value: string | null;
  valueTemplate: string | null;
  confidence: Finding["confidence"];
} {
  const generic = renderGenericValue(value, mode);
  return metadataFromGeneric(generic);
}

function collectObjectKeys(value: ResolvedValue, output: Set<string>): void {
  if (value.kind === "object") {
    Object.keys(value.properties).forEach((key) => output.add(key));
    return;
  }
  if (value.kind === "union") {
    value.options.forEach((option) => collectObjectKeys(option, output));
  }
}

function extractHeadersFromValue(value: ResolvedValue): FindingHeader[] {
  const headers: FindingHeader[] = [];

  if (value.kind === "array") {
    for (const element of value.elements) {
      if (element.kind !== "array" || element.elements.length < 2) {
        continue;
      }
      const nameValue = element.elements[0];
      if (nameValue.kind !== "literal") {
        continue;
      }
      const rendered = renderMetadataValueDetailed(element.elements[1], "inline");
      headers.push({
        name: nameValue.value,
        value: rendered.value,
        valueTemplate: rendered.valueTemplate,
        confidence: rendered.confidence,
      });
    }
    return headers;
  }

  const keys = new Set<string>();
  collectObjectKeys(value, keys);
  for (const key of [...keys].sort()) {
    const headerValue = getObjectProperty(value, key);
    if (!headerValue) {
      continue;
    }
    const rendered = renderMetadataValueDetailed(headerValue, "inline");
    headers.push({
      name: key,
      value: rendered.value,
      valueTemplate: rendered.valueTemplate,
      confidence: rendered.confidence,
    });
  }

  return headers;
}

interface ResolvedArg {
  path: NodePath<t.Expression>;
  value: ResolvedValue;
}

function resolveArg(
  path: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  index: number,
  resolve: (path: NodePath<t.Expression>) => ReturnType<typeof resolveExpression>,
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

function firstDefined<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function getObjectPropertyExpression(
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

function resolveFormDataEntries(
  formDataPath: NodePath<t.Expression>,
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  resolve: (path: NodePath<t.Expression>) => ReturnType<typeof resolveExpression>,
): Array<{
  key: string;
  rendered: ReturnType<typeof renderMetadataValueDetailed>;
}> {
  const entries: Array<{
    key: string;
    rendered: ReturnType<typeof renderMetadataValueDetailed>;
  }> = [];

  if (!formDataPath.isIdentifier()) {
    return entries;
  }

  const binding = formDataPath.scope.getBinding(formDataPath.node.name);
  if (!binding || !binding.path.isVariableDeclarator()) {
    return entries;
  }

  const initPath = binding.path.get("init");
  if (!initPath.isNewExpression()) {
    return entries;
  }

  const calleePath = initPath.get("callee");
  if (!calleePath.isIdentifier({ name: "FormData" })) {
    return entries;
  }

  for (const referencePath of binding.referencePaths) {
    const start = referencePath.node.start ?? 0;
    const sinkStart = sinkPath.node.start ?? Number.MAX_SAFE_INTEGER;
    if (start >= sinkStart) {
      continue;
    }

    const memberPath = referencePath.parentPath;
    if (!memberPath?.isMemberExpression()) {
      continue;
    }
    if (memberPath.node.object !== referencePath.node) {
      continue;
    }

    const propertyName =
      !memberPath.node.computed && t.isIdentifier(memberPath.node.property)
        ? memberPath.node.property.name
        : memberPath.node.computed && t.isStringLiteral(memberPath.node.property)
          ? memberPath.node.property.value
          : null;
    if (!propertyName || (propertyName !== "append" && propertyName !== "set")) {
      continue;
    }

    const callPath = memberPath.parentPath;
    if (!callPath?.isCallExpression()) {
      continue;
    }
    if (callPath.node.callee !== memberPath.node) {
      continue;
    }

    const args = callPath.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
    const keyArg = args[0];
    const valueArg = args[1];
    if (!keyArg?.isExpression() || !valueArg?.isExpression()) {
      continue;
    }

    const keyResolved = resolve(keyArg).value;
    const keyRendered = renderMetadataValueDetailed(keyResolved, "inline");
    const key = keyRendered.value ?? keyRendered.valueTemplate ?? "${field}";

    const valueResolved = resolve(valueArg).value;
    const renderedValue = renderMetadataValueDetailed(
      valueResolved,
      valueResolved.kind === "object" || valueResolved.kind === "array" ? "json" : "inline",
    );

    entries.push({
      key,
      rendered: renderedValue,
    });
  }

  return entries;
}

function resolveBodyFromExpression(
  bodyExpressionPath: NodePath<t.Expression>,
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  resolve: (path: NodePath<t.Expression>) => ReturnType<typeof resolveExpression>,
): FindingBody {
  if (bodyExpressionPath.isCallExpression()) {
    const calleePath = bodyExpressionPath.get("callee");
    if (calleePath.isMemberExpression()) {
      const objectPath = calleePath.get("object");
      const propertyName =
        !calleePath.node.computed && t.isIdentifier(calleePath.node.property)
          ? calleePath.node.property.name
          : calleePath.node.computed && t.isStringLiteral(calleePath.node.property)
            ? calleePath.node.property.value
            : null;

      if (propertyName === "stringify" && objectPath.isIdentifier({ name: "JSON" })) {
        const argPath = getArgumentExpressionPath(bodyExpressionPath, 0);
        if (argPath) {
          const resolvedArg = resolve(argPath).value;
          const renderedJson = renderMetadataValueDetailed(resolvedArg, "json");
          return {
            value: renderedJson.value,
            valueTemplate: renderedJson.valueTemplate,
            confidence: renderedJson.confidence,
          };
        }
      }
    }
  }

  if (bodyExpressionPath.isNewExpression()) {
    const calleePath = bodyExpressionPath.get("callee");
    if (calleePath.isIdentifier({ name: "FormData" })) {
      return {
        value: "FormData{}",
        valueTemplate: null,
        confidence: "medium",
      };
    }
  }

  const directResolved = resolve(bodyExpressionPath).value;

  if (directResolved.kind === "unknown" && bodyExpressionPath.isIdentifier()) {
    const formDataEntries = resolveFormDataEntries(bodyExpressionPath, sinkPath, resolve);
    if (formDataEntries.length > 0) {
      const hasUnknown = formDataEntries.some(
        (entry) => entry.rendered.confidence === "low",
      );
      const hasDynamic = formDataEntries.some(
        (entry) => entry.rendered.confidence === "medium",
      );
      const serialized = formDataEntries
        .map((entry) => {
          const value = entry.rendered.value ?? entry.rendered.valueTemplate ?? "${unknown}";
          return `${entry.key}=${value}`;
        })
        .join(", ");

      const confidence: Finding["confidence"] = hasUnknown
        ? "low"
        : hasDynamic
          ? "medium"
          : "high";

      if (confidence === "high") {
        return {
          value: `FormData{ ${serialized} }`,
          valueTemplate: null,
          confidence,
        };
      }

      return {
        value: null,
        valueTemplate: `FormData{ ${serialized} }`,
        confidence,
      };
    }
  }

  const rendered = renderMetadataValueDetailed(
    directResolved,
    directResolved.kind === "object" || directResolved.kind === "array"
      ? "json"
      : "inline",
  );
  return {
    value: rendered.value,
    valueTemplate: rendered.valueTemplate,
    confidence: rendered.confidence,
  };
}

function requestMetadataFromConfig(
  config: ResolvedValue | null,
  configPath: NodePath<t.Expression> | null,
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  resolve: (path: NodePath<t.Expression>) => ReturnType<typeof resolveExpression>,
): {
  headers: FindingHeader[];
  body: FindingBody | null;
} {
  if (!config) {
    return { headers: [], body: null };
  }

  const headersValue = getObjectProperty(config, "headers") ?? null;
  const bodyValue =
    firstDefined(
      getObjectProperty(config, "data"),
      getObjectProperty(config, "body"),
    ) ?? null;

  const headers = headersValue ? extractHeadersFromValue(headersValue) : [];
  let body: ReturnType<typeof renderMetadataValueDetailed> | null = null;

  const directBodyExpression =
    getObjectPropertyExpression(configPath, "data") ??
    getObjectPropertyExpression(configPath, "body");
  if (directBodyExpression) {
    const resolvedBody = resolveBodyFromExpression(directBodyExpression, sinkPath, resolve);
    body = {
      value: resolvedBody.value,
      valueTemplate: resolvedBody.valueTemplate,
      confidence: resolvedBody.confidence,
    };
  } else if (bodyValue) {
    body = renderMetadataValueDetailed(
      bodyValue,
      bodyValue.kind === "object" || bodyValue.kind === "array" ? "json" : "inline",
    );
  }

  return {
    headers,
    body: body
      ? {
          value: body.value,
          valueTemplate: body.valueTemplate,
          confidence: body.confidence,
        }
      : null,
  };
}

function mergeHeaders(
  left: FindingHeader[],
  right: FindingHeader[],
): FindingHeader[] {
  const merged = new Map<string, FindingHeader>();
  for (const header of [...left, ...right]) {
    merged.set(header.name.toLowerCase(), header);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function extractRequestMetadata(
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  sinkDefinition: SinkDefinition,
  resolve: (path: NodePath<t.Expression>) => ReturnType<typeof resolveExpression>,
): {
  headers: FindingHeader[];
  body: FindingBody | null;
} {
  let headers: FindingHeader[] = [];
  let body: FindingBody | null = null;

  const matchName = sinkDefinition.match;

  if (
    (matchName === "fetch" && sinkPath.isCallExpression()) ||
    (matchName === "Request" && sinkPath.isNewExpression())
  ) {
    const initConfig = resolveArg(sinkPath, 1, resolve);
    const fromConfig = requestMetadataFromConfig(
      initConfig?.value ?? null,
      initConfig?.path ?? null,
      sinkPath,
      resolve,
    );
    headers = mergeHeaders(headers, fromConfig.headers);
    body = body ?? fromConfig.body;
  } else if (matchName === "navigator.sendBeacon" && sinkPath.isCallExpression()) {
    const bodyArg = resolveArg(sinkPath, 1, resolve);
    if (bodyArg) {
      body = resolveBodyFromExpression(bodyArg.path, sinkPath, resolve);
    }
  } else if (matchName === "axios" && sinkPath.isCallExpression()) {
    const firstArg = resolveArg(sinkPath, 0, resolve);
    const secondArg = resolveArg(sinkPath, 1, resolve);

    const firstConfig = requestMetadataFromConfig(
      firstArg?.value ?? null,
      firstArg?.path ?? null,
      sinkPath,
      resolve,
    );
    const secondConfig = requestMetadataFromConfig(
      secondArg?.value ?? null,
      secondArg?.path ?? null,
      sinkPath,
      resolve,
    );

    headers = mergeHeaders(firstConfig.headers, secondConfig.headers);
    body = firstConfig.body ?? secondConfig.body;
  } else if (matchName.startsWith("axios.") && sinkPath.isCallExpression()) {
    const method = matchName.split(".")[1] ?? "";
    const configIndex = ["post", "put", "patch"].includes(method) ? 2 : 1;
    const configArg = resolveArg(sinkPath, configIndex, resolve);
    const configMetadata = requestMetadataFromConfig(
      configArg?.value ?? null,
      configArg?.path ?? null,
      sinkPath,
      resolve,
    );
    headers = mergeHeaders(headers, configMetadata.headers);

    if (["post", "put", "patch"].includes(method)) {
      const bodyArg = resolveArg(sinkPath, 1, resolve);
      if (bodyArg) {
        body = resolveBodyFromExpression(bodyArg.path, sinkPath, resolve);
      }
    }

    body = body ?? configMetadata.body;
  }

  if (headers.length === 0 && body === null && sinkPath.isCallExpression()) {
    const fallbackConfig = resolveArg(
      sinkPath,
      sinkDefinition.urlArg + 1,
      resolve,
    );
    const fallbackMetadata = requestMetadataFromConfig(
      fallbackConfig?.value ?? null,
      fallbackConfig?.path ?? null,
      sinkPath,
      resolve,
    );
    headers = mergeHeaders(headers, fallbackMetadata.headers);
    body = body ?? fallbackMetadata.body;
  }

  return {
    headers,
    body,
  };
}

function resolveGeneratedLine(
  traceMap: TraceMap | null,
  sourceName: string,
  location: { line: number; column: number } | null | undefined,
): number | null {
  if (!traceMap || !location) {
    return null;
  }

  const sources = [sourceName, ...traceMap.sources]
    .filter((source): source is string => Boolean(source))
    .filter((source, index, array) => array.indexOf(source) === index);

  for (const source of sources) {
    try {
      const generated = generatedPositionFor(traceMap, {
        source,
        line: location.line,
        column: location.column,
      });
      if (generated.line !== null && generated.line > 0) {
        return generated.line;
      }
    } catch {
      // Try next possible source key.
    }
  }

  return null;
}

function fallbackGeneratedLineFromCode(prettySource: string, node: t.Node): number | null {
  let generatedNode = "";
  try {
    generatedNode = generate(node, {
      comments: false,
      compact: false,
      jsescOption: { minimal: true },
    }).code;
  } catch {
    return null;
  }

  const needle = generatedNode
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!needle) {
    return null;
  }

  const index = prettySource.indexOf(needle);
  if (index < 0) {
    return null;
  }

  return prettySource.slice(0, index).split(/\r?\n/).length;
}

function buildCodeSnippet(
  prettySource: string,
  prettyLines: string[],
  traceMap: TraceMap | null,
  sourceName: string,
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
): string | undefined {
  const statementPath = sinkPath.findParent((parentPath) =>
    parentPath.isStatement(),
  ) as NodePath<t.Statement> | null;
  const ownerFunction = sinkPath.findParent((parentPath) =>
    parentPath.isFunction(),
  ) as NodePath<t.Function> | null;

  const focusNode = statementPath?.node ?? sinkPath.node;
  const contextNode = ownerFunction?.node ?? focusNode;

  const fallbackLine =
    fallbackGeneratedLineFromCode(prettySource, focusNode) ??
    fallbackGeneratedLineFromCode(prettySource, sinkPath.node) ??
    1;

  const resolvedFocusLine =
    resolveGeneratedLine(traceMap, sourceName, focusNode.loc?.start) ?? fallbackLine;

  let contextStartLine =
    resolveGeneratedLine(traceMap, sourceName, contextNode.loc?.start) ?? 1;
  let contextEndLine =
    resolveGeneratedLine(traceMap, sourceName, contextNode.loc?.end) ?? prettyLines.length;

  if (contextStartLine > contextEndLine) {
    const temp = contextStartLine;
    contextStartLine = contextEndLine;
    contextEndLine = temp;
  }

  contextStartLine = Math.max(1, Math.min(contextStartLine, prettyLines.length));
  contextEndLine = Math.max(1, Math.min(contextEndLine, prettyLines.length));

  const focusLine = Math.max(1, Math.min(resolvedFocusLine, prettyLines.length));

  if (focusLine < contextStartLine || focusLine > contextEndLine) {
    contextStartLine = 1;
    contextEndLine = prettyLines.length;
  }

  const lineWindow = 26;
  const before = Math.floor((lineWindow - 1) / 2);
  let startLine = Math.max(contextStartLine, focusLine - before);
  let endLine = Math.min(contextEndLine, startLine + lineWindow - 1);

  if (endLine - startLine + 1 < lineWindow) {
    startLine = Math.max(contextStartLine, endLine - lineWindow + 1);
  }

  const chunk = prettyLines.slice(startLine - 1, endLine);
  while (chunk.length > 0 && chunk[0].trim().length === 0) {
    chunk.shift();
    startLine += 1;
  }
  while (chunk.length > 0 && chunk[chunk.length - 1].trim().length === 0) {
    chunk.pop();
    endLine -= 1;
  }

  if (chunk.length === 0) {
    return undefined;
  }

  const output: string[] = [];
  if (startLine > contextStartLine) {
    output.push("...");
  }
  output.push(...chunk);
  if (endLine < contextEndLine) {
    output.push("...");
  }

  return output.join("\n");
}

function analyzeAst(
  ast: t.File,
  source: string,
  filePath: string,
  options: AnalyzeSourceOptions,
): Finding[] {
  const sinkDefinitions = options.sinkDefinitions ?? builtinSinks;
  const includeUnresolved = options.includeUnresolved ?? false;

  const indexes = collectResolverIndexes(ast);
  const globalSymbolValues = buildGlobalSymbolValues(sinkDefinitions);
  const resolverContext: ResolverContext = {
    callSitesByFunction: indexes.callSitesByFunction,
    functionPaths: indexes.functionPaths,
    webpackModulesById: indexes.webpackModulesById,
    webpackModuleByFunction: indexes.webpackModuleByFunction,
    webpackExternalModulesById:
      options.webpackExternalModulesById ?? new Map<string, Record<string, ResolvedValue>>(),
    globalSymbolValues,
    memberAssignments: indexes.memberAssignments,
    maxDepth: options.maxDepth ?? 12,
  };

  augmentIndirectCallSites(ast, resolverContext);

  const resolve = (path: NodePath<t.Expression>) =>
    resolveWithState(path, resolverContext);
  const prettySourceName = normalizeFilePath(filePath);
  const prettyGenerated = (() => {
    try {
      return generate(
        ast,
        {
          comments: false,
          compact: false,
          sourceMaps: true,
          sourceFileName: prettySourceName,
          jsescOption: { minimal: true },
        },
        source,
      );
    } catch {
      return null;
    }
  })();
  const prettySource = prettyGenerated?.code ?? source;
  const prettyLines = prettySource.split(/\r?\n/);
  const prettyTraceMap = prettyGenerated?.map
    ? new TraceMap(prettyGenerated.map as any)
    : null;

  const findings: Finding[] = [];

  const processSink = (path: NodePath<t.CallExpression> | NodePath<t.NewExpression>) => {
    const matched = matchSink(path, {
      sinkDefinitions,
      resolveExpression: resolve,
    });
    const targets: ResolvedSinkTarget[] = [];

    if (matched) {
      targets.push({
        definition: matched.definition,
        baseURL: matched.baseURL,
        indirectTrace: [],
      });
    } else {
      targets.push(...resolveIndirectSinkTargets(path, resolve));
    }

    if (targets.length === 0) {
      return;
    }

    for (const target of targets) {
      let urlValue: ResolvedValue | null = null;
      let method: string | null = target.definition.httpMethod ?? null;
      const trace: string[] = [...target.indirectTrace];

      if (target.definition.match === "axios" && path.isCallExpression()) {
        const axiosResolved = resolveAxiosCall(path, resolve);
        urlValue = axiosResolved.urlValue;
        method = method ?? axiosResolved.method;
        trace.push(...axiosResolved.trace);
      } else {
        const urlResolved = resolveCallArgumentByIndex(path, target.definition.urlArg, resolve);
        if (urlResolved) {
          urlValue = urlResolved.value;
          trace.push(...urlResolved.trace);
        }
      }

      if (target.baseURL && urlValue) {
        urlValue = joinBaseAndPath(target.baseURL, urlValue);
        trace.push("Join(baseURL,path)");
      }

      if (
        !target.baseURL &&
        typeof target.definition.baseURLArg === "number" &&
        urlValue
      ) {
        const baseArgResolved = resolveCallArgumentByIndex(
          path,
          target.definition.baseURLArg,
          resolve,
        );
        if (baseArgResolved) {
          urlValue = joinBaseAndPath(baseArgResolved.value, urlValue);
          trace.push(...baseArgResolved.trace);
          trace.push("Join(baseURLArg,path)");
        }
      }

      if (
        !target.baseURL &&
        target.definition.match.startsWith("axios.") &&
        path.isCallExpression() &&
        urlValue
      ) {
        const inlineBaseURL = resolveAxiosMethodBaseURL(path, resolve);
        if (inlineBaseURL) {
          urlValue = joinBaseAndPath(inlineBaseURL, urlValue);
          trace.push("Join(axiosMethodConfig.baseURL,path)");
        }
      }

      if (!method && typeof target.definition.methodArg === "number") {
        const methodResolved = resolveCallArgumentByIndex(
          path,
          target.definition.methodArg,
          resolve,
        );
        if (methodResolved) {
          method = toHttpMethod(methodResolved.value);
          trace.push(...methodResolved.trace);
        }
      }

      if (!method && target.definition.match === "fetch" && path.isCallExpression()) {
        method = resolveFetchLikeMethod(path, resolve) ?? "GET";
      }

      if (!method && target.definition.match === "Request" && path.isNewExpression()) {
        method = resolveFetchLikeMethod(path, resolve) ?? "GET";
      }

      const requestMetadata = extractRequestMetadata(path, target.definition, resolve);

      const rendered = urlValue ? renderValue(urlValue) : null;
      if (!rendered && !includeUnresolved) {
        continue;
      }

      if (
        rendered &&
        !includeUnresolved &&
        rendered.url === null &&
        rendered.urlTemplate === null
      ) {
        continue;
      }

      const location = path.node.loc?.start;
      const line = location?.line ?? 1;
      const column = (location?.column ?? 0) + 1;
      const finding: Finding = {
        file: normalizeFilePath(filePath),
        line,
        column,
        sink: target.definition.name,
        method,
        url: rendered?.url ?? null,
        urlTemplate: rendered?.urlTemplate ?? null,
        confidence: rendered?.confidence ?? "low",
        resolutionTrace: dedupeTrace([...trace, `Sink(${target.definition.name})`]),
        codeSnippet: buildCodeSnippet(
          prettySource,
          prettyLines,
          prettyTraceMap,
          prettySourceName,
          path,
        ),
        headers: requestMetadata.headers.length > 0 ? requestMetadata.headers : undefined,
        body: requestMetadata.body,
      };

      findings.push(finding);
    }
  };

  traverse(ast, {
    CallExpression(path) {
      try {
        processSink(path);
      } catch {
        // Keep analysis resilient per-file and continue.
      }
    },
    NewExpression(path) {
      try {
        processSink(path);
      } catch {
        // Keep analysis resilient per-file and continue.
      }
    },
  });

  return findings;
}

export function analyzeSource(
  source: string,
  filePath: string,
  options: AnalyzeSourceOptions = {},
): AnalyzeFileResult {
  const parsed = parseCode(source, filePath);
  if (!parsed.ast) {
    return {
      file: normalizeFilePath(filePath),
      findings: [],
      errors: parsed.errors,
    };
  }

  const findings = analyzeAst(parsed.ast, source, filePath, options);

  return {
    file: normalizeFilePath(filePath),
    findings,
    errors: parsed.errors,
  };
}

export async function analyzeFile(
  filePath: string,
  options: AnalyzeSourceOptions = {},
): Promise<AnalyzeFileResult> {
  const parsed = await parseFile(filePath);
  if (!parsed.ast) {
    return {
      file: normalizeFilePath(filePath),
      findings: [],
      errors: parsed.errors,
    };
  }

  const findings = analyzeAst(parsed.ast, parsed.source, filePath, options);

  return {
    file: normalizeFilePath(filePath),
    findings,
    errors: parsed.errors,
  };
}
