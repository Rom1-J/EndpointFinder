import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Finding, FindingBody } from "../../../types";
import { renderMetadataValueDetailed } from "./render";
import { getArgumentExpressionPath, type ResolveFn } from "./args";

function resolveFormDataEntries(
  formDataPath: NodePath<t.Expression>,
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  resolve: ResolveFn,
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

export function resolveBodyFromExpression(
  bodyExpressionPath: NodePath<t.Expression>,
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  resolve: ResolveFn,
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
