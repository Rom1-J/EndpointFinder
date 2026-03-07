import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { ResolverState } from "../types";

export function nextState(
  state: ResolverState,
  overrides: Partial<ResolverState> = {},
): ResolverState {
  return {
    ...state,
    ...overrides,
    depth: overrides.depth ?? state.depth + 1,
  };
}

export function addTrace(prefix: string, parts: string[][]): string[] {
  const trace = [prefix];
  for (const part of parts) {
    trace.push(...part);
  }
  return trace;
}

export function getCallArguments(path: NodePath<t.CallExpression>) {
  return path.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
}

export function getArgumentExpressionPath(
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

export function getParamBindingIdentifier(
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

export function collectReturnExpressions(
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

export function unwrapCalleePath(
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
