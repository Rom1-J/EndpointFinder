import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";

function isViteHelperIdentifier(
  path: NodePath<t.LVal | t.VoidPattern>,
): boolean {
  return path.isIdentifier({ name: "__vite__mapDeps" });
}

function isViteHelperDeclaration(path: NodePath<t.Node>): boolean {
  if (path.isVariableDeclarator()) {
    const idPath = path.get("id");
    return isViteHelperIdentifier(idPath);
  }
  if (path.isFunctionDeclaration()) {
    return Boolean(path.node.id && path.node.id.name === "__vite__mapDeps");
  }
  return false;
}

function staticMemberPropertyName(node: t.MemberExpression): string | null {
  if (t.isIdentifier(node.property) && !node.computed) {
    return node.property.name;
  }
  if (node.computed && t.isStringLiteral(node.property)) {
    return node.property.value;
  }
  return null;
}

function isViteDepMapAssignment(path: NodePath<t.AssignmentExpression>): boolean {
  if (path.node.operator !== "=") {
    return false;
  }

  const leftPath = path.get("left");
  const rightPath = path.get("right");
  if (!leftPath.isMemberExpression() || !rightPath.isArrayExpression()) {
    return false;
  }

  return staticMemberPropertyName(leftPath.node) === "f";
}

function extractStringArray(path: NodePath<t.ArrayExpression>): string[] {
  const values: string[] = [];
  for (const elementPath of path.get("elements")) {
    if (!elementPath || !elementPath.isStringLiteral()) {
      continue;
    }
    values.push(elementPath.node.value);
  }
  return values;
}

/**
 * Extracts Vite dependency-map entries from __vite__mapDeps helper initializers.
 *
 * Vite commonly emits patterns like:
 *   m.f || (m.f = ["chunk-a.js", "chunk-b.js"])
 */
export function extractViteDepMapSpecifiers(ast: t.File): string[] {
  const specifiers = new Set<string>();

  traverse(ast, {
    VariableDeclarator(path) {
      if (!isViteHelperDeclaration(path)) {
        return;
      }

      const initPath = path.get("init");
      if (!initPath.node) {
        return;
      }

      initPath.traverse({
        AssignmentExpression(assignmentPath) {
          if (!isViteDepMapAssignment(assignmentPath)) {
            return;
          }

          const rightPath = assignmentPath.get("right");
          if (!rightPath.isArrayExpression()) {
            return;
          }

          extractStringArray(rightPath).forEach((entry) => specifiers.add(entry));
        },
      });
    },
    FunctionDeclaration(path) {
      if (!isViteHelperDeclaration(path)) {
        return;
      }

      path.traverse({
        AssignmentExpression(assignmentPath) {
          if (!isViteDepMapAssignment(assignmentPath)) {
            return;
          }

          const rightPath = assignmentPath.get("right");
          if (!rightPath.isArrayExpression()) {
            return;
          }

          extractStringArray(rightPath).forEach((entry) => specifiers.add(entry));
        },
      });
    },
  });

  return [...specifiers];
}
