import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
  callableValue,
  functionRefValue,
  objectValue,
  unknownValue,
  type ResolvedValue,
} from "../valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "../types";
import { collectReturnExpressions, getArgumentExpressionPath, nextState } from "./state";

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

function addTrace(prefix: string, parts: string[][]): string[] {
  const trace = [prefix];
  for (const part of parts) {
    trace.push(...part);
  }
  return trace;
}

export function resolveWebpackRequireCall(
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
