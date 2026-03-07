import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { ResolvedValue } from "../../resolver/valueModel";
import {
  extractReturnExpressions,
  propertyKeyToString,
  resolveSimpleExpression,
} from "./expression";

export type ExternalWebpackRegistry = Map<string, Record<string, ResolvedValue>>;

function readWebpackExportsFromModuleFunction(
  moduleFunctionPath: NodePath<t.Function>,
): Record<string, ResolvedValue> {
  const params = moduleFunctionPath.node.params;
  const exportsParamName =
    params[1] && t.isIdentifier(params[1]) ? params[1].name : null;
  const requireParamName =
    params[2] && t.isIdentifier(params[2]) ? params[2].name : null;

  if (!exportsParamName || !requireParamName) {
    return {};
  }

  const exports: Record<string, ResolvedValue> = {};

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

      const args = callPath.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
      const firstArg = args[0];
      const secondArg = args[1];
      if (!firstArg?.isIdentifier({ name: exportsParamName })) {
        return;
      }
      if (!secondArg?.isObjectExpression()) {
        return;
      }

      for (const exportPropPath of secondArg.get("properties")) {
        if (!exportPropPath.isObjectProperty() && !exportPropPath.isObjectMethod()) {
          continue;
        }
        const exportName = propertyKeyToString(
          exportPropPath as NodePath<t.ObjectProperty | t.ObjectMethod>,
        );
        if (!exportName) {
          continue;
        }

        if (exportPropPath.isObjectMethod()) {
          const returns = extractReturnExpressions(exportPropPath);
          if (returns.length === 1) {
            exports[exportName] = resolveSimpleExpression(returns[0]);
          }
          continue;
        }

        const valuePath = exportPropPath.get("value");
        if (
          valuePath.isFunctionExpression() ||
          valuePath.isArrowFunctionExpression()
        ) {
          const returns = extractReturnExpressions(valuePath);
          if (returns.length === 1) {
            exports[exportName] = resolveSimpleExpression(returns[0]);
          }
          continue;
        }

        if (valuePath.isExpression()) {
          exports[exportName] = resolveSimpleExpression(valuePath);
        }
      }
    },
  });

  return exports;
}

export function collectWebpackExternalModulesFromAst(
  ast: t.File,
): ExternalWebpackRegistry {
  const modules = new Map<string, Record<string, ResolvedValue>>();

  traverse(ast, {
    CallExpression(path) {
      const args = path.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
      const firstArg = args[0];
      if (!firstArg || !firstArg.isArrayExpression()) {
        return;
      }

      const elements = firstArg.get("elements");
      const moduleObjectPath = elements[1];
      if (!moduleObjectPath || !moduleObjectPath.isObjectExpression()) {
        return;
      }

      for (const modulePropPath of moduleObjectPath.get("properties")) {
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

        const exports = readWebpackExportsFromModuleFunction(
          moduleValuePath as NodePath<t.Function>,
        );
        if (Object.keys(exports).length > 0) {
          modules.set(moduleId, exports);
        }
      }
    },
  });

  return modules;
}
