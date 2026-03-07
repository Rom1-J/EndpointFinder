import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
  isSinkRefValue,
  objectValue,
  sinkRefValue,
  unionValues,
  unknownValue,
  type ResolvedValue,
  type SinkRefValue,
} from "../../resolver/valueModel";
import { getFunctionPathFromCallee } from "../../resolver/resolveCall";
import type { ResolverContext, ResolvedResult } from "../../resolver/types";
import type { SinkDefinition } from "../../sinks/sinkConfig";

type ResolveFn = (path: NodePath<t.Expression>) => ResolvedResult;
type ResolveWithContext = (
  path: NodePath<t.Expression>,
  context: ResolverContext,
) => ResolvedResult;

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

export function buildGlobalSymbolValues(
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

export function augmentIndirectCallSites(
  callExpressionPaths: NodePath<t.CallExpression>[],
  context: ResolverContext,
  resolveWithContext: ResolveWithContext,
): void {
  const maxPasses = 3;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    // Keep a pass-local cache so repeated callee resolutions inside the same
    // fixed-point pass are reused without leaking stale data across passes.
    const passCache = new WeakMap<t.Expression, ResolvedResult>();

    for (const path of callExpressionPaths) {
      const directFunctionPath = getFunctionPathFromCallee(
        path.get("callee") as NodePath<t.Expression | t.V8IntrinsicIdentifier | t.Super>,
      );
      if (directFunctionPath) {
        continue;
      }

      const calleePath = path.get("callee");
      if (!calleePath.isExpression()) {
        continue;
      }

      if (calleePath.isIdentifier() && !calleePath.scope.getBinding(calleePath.node.name)) {
        continue;
      }

      const cached = passCache.get(calleePath.node as t.Expression);
      const resolved =
        cached ?? resolveWithContext(calleePath as NodePath<t.Expression>, context);
      if (!cached) {
        passCache.set(calleePath.node as t.Expression, resolved);
      }

      const functionRefs = new Set<t.Function>();
      collectFunctionRefs(resolved.value, functionRefs);

      for (const functionRef of functionRefs) {
        changed =
          addCallSiteIfMissing(context.callSitesByFunction, functionRef, path) ||
          changed;
      }
    }

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

export function resolveCallArgumentByIndex(
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  index: number,
  resolve: ResolveFn,
): ResolvedResult | null {
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

export interface ResolvedSinkTarget {
  definition: SinkDefinition;
  baseURL: ResolvedValue | null;
  indirectTrace: string[];
}

export function resolveIndirectSinkTargets(
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  resolve: ResolveFn,
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
