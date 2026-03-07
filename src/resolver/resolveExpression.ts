import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { resolveCallExpression, resolveNewExpression } from "./resolveCall";
import { resolveIdentifier } from "./resolveIdentifier";
import {
  concatValues,
  dynamicValue,
  functionRefValue,
  literalValue,
  unionValues,
  unknownValue,
} from "./valueModel";
import type { ResolvedResult, ResolverContext, ResolverState } from "./types";
import { resolveArrayExpression, resolveObjectExpression } from "./expression/collections";
import { resolveMemberExpression } from "./expression/member";
import { combineTrace, nextState, unwrapTypeExpressions } from "./expression/state";

export function resolveExpression(
  path: NodePath<t.Expression>,
  state: ResolverState,
): ResolvedResult {
  if (state.depth >= state.context.maxDepth) {
    return {
      value: unknownValue("max-depth-expression"),
      trace: ["Expression", "DepthLimit"],
    };
  }

  const unwrappedPath = unwrapTypeExpressions(path);

  if (unwrappedPath.isStringLiteral()) {
    return {
      value: literalValue(unwrappedPath.node.value),
      trace: ["StringLiteral"],
    };
  }

  if (unwrappedPath.isNumericLiteral()) {
    return {
      value: literalValue(String(unwrappedPath.node.value)),
      trace: ["NumericLiteral"],
    };
  }

  if (unwrappedPath.isBooleanLiteral()) {
    return {
      value: literalValue(String(unwrappedPath.node.value)),
      trace: ["BooleanLiteral"],
    };
  }

  if (unwrappedPath.isNullLiteral()) {
    return {
      value: literalValue("null"),
      trace: ["NullLiteral"],
    };
  }

  if (unwrappedPath.isThisExpression()) {
    return {
      value: dynamicValue("this"),
      trace: ["ThisExpression"],
    };
  }

  if (unwrappedPath.isTemplateLiteral()) {
    const parts = [];
    const traces: string[][] = [];
    const expressionPaths = unwrappedPath.get("expressions");

    for (let index = 0; index < unwrappedPath.node.quasis.length; index += 1) {
      const quasi = unwrappedPath.node.quasis[index];
      if (quasi.value.cooked) {
        parts.push(literalValue(quasi.value.cooked));
      }
      const expressionPath = expressionPaths[index];
      if (expressionPath && expressionPath.isExpression()) {
        const resolved = resolveExpression(expressionPath, nextState(state));
        parts.push(resolved.value);
        traces.push(resolved.trace);
      }
    }

    return {
      value: concatValues(parts),
      trace: combineTrace("TemplateLiteral", traces),
    };
  }

  if (unwrappedPath.isFunctionExpression() || unwrappedPath.isArrowFunctionExpression()) {
    const functionName =
      unwrappedPath.isFunctionExpression() && unwrappedPath.node.id
        ? unwrappedPath.node.id.name
        : null;
    const label =
      functionName ??
      (unwrappedPath.parentPath?.isVariableDeclarator() &&
      t.isIdentifier(unwrappedPath.parentPath.node.id)
        ? unwrappedPath.parentPath.node.id.name
        : "anonymous");
    return {
      value: functionRefValue(unwrappedPath.node, `function:${label}`),
      trace: [unwrappedPath.node.type],
    };
  }

  if (unwrappedPath.isBinaryExpression({ operator: "+" })) {
    const leftPath = unwrappedPath.get("left") as NodePath<t.Expression>;
    const rightPath = unwrappedPath.get("right") as NodePath<t.Expression>;

    const leftResolved = resolveExpression(leftPath, nextState(state));
    const rightResolved = resolveExpression(rightPath, nextState(state));

    return {
      value: concatValues([leftResolved.value, rightResolved.value]),
      trace: combineTrace("BinaryExpression(+)", [
        leftResolved.trace,
        rightResolved.trace,
      ]),
    };
  }

  if (unwrappedPath.isIdentifier()) {
    return resolveIdentifier(unwrappedPath, state, resolveExpression);
  }

  if (unwrappedPath.isObjectExpression()) {
    return resolveObjectExpression(unwrappedPath, state, resolveExpression);
  }

  if (unwrappedPath.isArrayExpression()) {
    return resolveArrayExpression(unwrappedPath, state, resolveExpression);
  }

  if (unwrappedPath.isMemberExpression()) {
    return resolveMemberExpression(unwrappedPath, state, resolveExpression);
  }

  if (unwrappedPath.isConditionalExpression()) {
    const consequent = resolveExpression(
      unwrappedPath.get("consequent"),
      nextState(state),
    );
    const alternate = resolveExpression(
      unwrappedPath.get("alternate"),
      nextState(state),
    );

    return {
      value: unionValues([consequent.value, alternate.value]),
      trace: combineTrace("ConditionalExpression", [
        consequent.trace,
        alternate.trace,
      ]),
    };
  }

  if (unwrappedPath.isLogicalExpression()) {
    const left = resolveExpression(unwrappedPath.get("left"), nextState(state));
    const right = resolveExpression(unwrappedPath.get("right"), nextState(state));

    return {
      value: unionValues([left.value, right.value]),
      trace: combineTrace(`LogicalExpression(${unwrappedPath.node.operator})`, [
        left.trace,
        right.trace,
      ]),
    };
  }

  if (unwrappedPath.isSequenceExpression()) {
    const expressions = unwrappedPath.get("expressions");
    const last = expressions[expressions.length - 1];
    if (!last || !last.isExpression()) {
      return {
        value: unknownValue("empty-sequence"),
        trace: ["SequenceExpression", "Empty"],
      };
    }
    const resolved = resolveExpression(last, nextState(state));
    return {
      value: resolved.value,
      trace: ["SequenceExpression", ...resolved.trace],
    };
  }

  if (unwrappedPath.isAssignmentExpression()) {
    const right = unwrappedPath.get("right");
    if (!right.isExpression()) {
      return {
        value: unknownValue("assignment-right"),
        trace: ["AssignmentExpression", "NoRight"],
      };
    }
    const resolved = resolveExpression(right, nextState(state));
    return {
      value: resolved.value,
      trace: ["AssignmentExpression", ...resolved.trace],
    };
  }

  if (unwrappedPath.isAwaitExpression()) {
    const argPath = unwrappedPath.get("argument");
    if (!argPath.isExpression()) {
      return {
        value: unknownValue("await-arg"),
        trace: ["AwaitExpression", "NoArgument"],
      };
    }
    const resolved = resolveExpression(argPath, nextState(state));
    return {
      value: resolved.value,
      trace: ["AwaitExpression", ...resolved.trace],
    };
  }

  if (unwrappedPath.isUnaryExpression()) {
    const argPath = unwrappedPath.get("argument");
    if (argPath.isExpression()) {
      const argResolved = resolveExpression(argPath, nextState(state));
      if (unwrappedPath.node.operator === "typeof") {
        return {
          value: dynamicValue("typeof"),
          trace: ["UnaryExpression(typeof)", ...argResolved.trace],
        };
      }
      return {
        value: argResolved.value,
        trace: [
          `UnaryExpression(${unwrappedPath.node.operator})`,
          ...argResolved.trace,
        ],
      };
    }
  }

  if (unwrappedPath.isCallExpression()) {
    return resolveCallExpression(unwrappedPath, state, resolveExpression);
  }

  if (unwrappedPath.isNewExpression()) {
    return resolveNewExpression(unwrappedPath, state, resolveExpression);
  }

  return {
    value: unknownValue(unwrappedPath.node.type),
    trace: [unwrappedPath.node.type, "UnsupportedExpression"],
  };
}

export function resolveWithContext(
  path: NodePath<t.Expression>,
  context: ResolverContext,
): ResolvedResult {
  const initialState: ResolverState = {
    context,
    env: new Map(),
    visited: new Set(),
    depth: 0,
  };
  return resolveExpression(path, initialState);
}
