import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { expressionToPath, getStaticPropertyName } from "../../utils/ast";
import { getObjectProperty, unionValues, unknownValue } from "../valueModel";
import type {
  ResolveExpressionFn,
  ResolvedResult,
  ResolverState,
} from "../types";
import { combineTrace, nextState } from "./state";

export function resolveMemberExpression(
  path: NodePath<t.MemberExpression>,
  state: ResolverState,
  resolveExpression: ResolveExpressionFn,
): ResolvedResult {
  const staticPath = expressionToPath(path.node as t.Expression);
  if (staticPath) {
    const assignments = state.context.memberAssignments.get(staticPath);
    if (assignments && assignments.length > 0) {
      const resolvedAssignments = assignments.map((assignmentPath) =>
        resolveExpression(assignmentPath, nextState(state)),
      );
      return {
        value: unionValues(resolvedAssignments.map((entry) => entry.value)),
        trace: combineTrace(`MemberExpression(${staticPath})`, [
          ...resolvedAssignments.map((entry) => entry.trace),
          ["MemberAssignmentAlias"],
        ]),
      };
    }
  }

  const objectPath = path.get("object") as NodePath<
    t.Expression | t.Super | t.PrivateName
  >;
  if (!objectPath.isExpression()) {
    return {
      value: unknownValue("member-object"),
      trace: ["MemberExpression", "InvalidObject"],
    };
  }

  const objectResolved = resolveExpression(
    objectPath as NodePath<t.Expression>,
    nextState(state),
  );
  const property = getStaticPropertyName(path.node);
  if (!property) {
    return {
      value: unknownValue("computed-member"),
      trace: ["MemberExpression", ...objectResolved.trace, "Computed"],
    };
  }

  const propertyValue = getObjectProperty(objectResolved.value, property);
  if (!propertyValue) {
    return {
      value: unknownValue(`member:${property}`),
      trace: ["MemberExpression", ...objectResolved.trace, `Property(${property})`],
    };
  }

  return {
    value: propertyValue,
    trace: ["MemberExpression", ...objectResolved.trace, `Property(${property})`],
  };
}
