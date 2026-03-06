import * as t from "@babel/types";

function memberPath(
  node: t.MemberExpression | t.OptionalMemberExpression,
): string | null {
  const objectPath = expressionToPath(node.object);
  if (!objectPath) {
    return null;
  }
  const property = getStaticPropertyName(node);
  if (!property) {
    return null;
  }
  return `${objectPath}.${property}`;
}

export function getStaticPropertyName(
  node: t.MemberExpression | t.OptionalMemberExpression,
): string | null {
  if (!node.computed && t.isIdentifier(node.property)) {
    return node.property.name;
  }
  if (node.computed && t.isStringLiteral(node.property)) {
    return node.property.value;
  }
  return null;
}

export function expressionToPath(
  node:
    | t.Expression
    | t.PrivateName
    | t.Super
    | t.V8IntrinsicIdentifier,
): string | null {
  if (t.isIdentifier(node)) {
    return node.name;
  }
  if (t.isThisExpression(node)) {
    return "this";
  }
  if (t.isSuper(node)) {
    return "super";
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    return memberPath(node);
  }
  if (t.isStringLiteral(node)) {
    return node.value;
  }
  return null;
}

export function snippetAtLine(
  lines: string[],
  line: number,
): string | undefined {
  const raw = lines[line - 1];
  if (raw === undefined) {
    return undefined;
  }
  return raw.trim();
}

export function snippetFromRange(
  source: string,
  contextStart: number,
  contextEnd: number,
  focusStart: number,
  focusEnd: number,
  maxLength = 280,
): string | undefined {
  if (source.length === 0) {
    return undefined;
  }

  const contextMin = Math.max(0, Math.min(contextStart, source.length));
  const contextMax = Math.max(contextMin, Math.min(contextEnd, source.length));
  const focusMin = Math.max(contextMin, Math.min(focusStart, contextMax));
  const focusMax = Math.max(focusMin, Math.min(focusEnd, contextMax));

  if (contextMax <= contextMin) {
    return undefined;
  }

  const contextLength = contextMax - contextMin;
  let sliceStart = contextMin;
  let sliceEnd = contextMax;

  if (contextLength > maxLength) {
    const focusMid = Math.floor((focusMin + focusMax) / 2);
    const half = Math.floor(maxLength / 2);
    sliceStart = Math.max(contextMin, focusMid - half);
    sliceEnd = Math.min(contextMax, sliceStart + maxLength);

    if (sliceEnd - sliceStart < maxLength) {
      sliceStart = Math.max(contextMin, sliceEnd - maxLength);
    }
  }

  let snippet = source.slice(sliceStart, sliceEnd).replace(/\s+/g, " ").trim();
  if (snippet.length === 0) {
    return undefined;
  }

  const hasLeftTrim = sliceStart > contextMin || contextMin > 0;
  const hasRightTrim = sliceEnd < contextMax || contextMax < source.length;

  if (hasLeftTrim) {
    snippet = `...${snippet}`;
  }
  if (hasRightTrim) {
    snippet = `${snippet}...`;
  }

  return snippet;
}

export function dedupeTrace(trace: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of trace) {
    if (!seen.has(item)) {
      output.push(item);
      seen.add(item);
    }
  }
  return output;
}

export function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
