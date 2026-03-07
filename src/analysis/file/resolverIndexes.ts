import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { getFunctionPathFromCallee } from "../../resolver/resolveCall";
import type { WebpackModuleInfo } from "../../resolver/types";
import { expressionToPath } from "../../utils/ast";

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

export interface ResolverIndexes {
  callSitesByFunction: Map<t.Function, NodePath<t.CallExpression>[]>;
  functionPaths: Map<t.Function, NodePath<t.Function>>;
  webpackModulesById: Map<string, WebpackModuleInfo>;
  webpackModuleByFunction: Map<t.Function, WebpackModuleInfo>;
  memberAssignments: Map<string, NodePath<t.Expression>[]>;
  callExpressions: NodePath<t.CallExpression>[];
  newExpressions: NodePath<t.NewExpression>[];
}

export function collectResolverIndexes(ast: t.File): ResolverIndexes {
  // Build all reusable per-file indexes in one AST traversal.
  // These indexes are later reused by resolution and sink processing to avoid
  // additional full-tree scans.
  const callSitesByFunction = new Map<t.Function, NodePath<t.CallExpression>[]>();
  const functionPaths = new Map<t.Function, NodePath<t.Function>>();
  const webpackModulesById = new Map<string, WebpackModuleInfo>();
  const webpackModuleByFunction = new Map<t.Function, WebpackModuleInfo>();
  const memberAssignments = new Map<string, NodePath<t.Expression>[]>();
  const callExpressions: NodePath<t.CallExpression>[] = [];
  const newExpressions: NodePath<t.NewExpression>[] = [];

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
      callExpressions.push(path);

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
    NewExpression(path) {
      newExpressions.push(path);
    },
  });

  return {
    callSitesByFunction,
    functionPaths,
    webpackModulesById,
    webpackModuleByFunction,
    memberAssignments,
    callExpressions,
    newExpressions,
  };
}
