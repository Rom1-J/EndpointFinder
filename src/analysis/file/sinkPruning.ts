import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

export function shouldAttemptIndirectResolution(
  path: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
): boolean {
  const calleePath = path.get("callee") as NodePath<
    t.Expression | t.V8IntrinsicIdentifier | t.Super
  >;
  if (!calleePath.isExpression()) {
    return false;
  }

  if (calleePath.isIdentifier()) {
    return Boolean(calleePath.scope.getBinding(calleePath.node.name));
  }

  if (calleePath.isMemberExpression()) {
    const objectPath = calleePath.get("object");
    if (objectPath.isIdentifier() && !objectPath.scope.getBinding(objectPath.node.name)) {
      return false;
    }
  }

  return true;
}
