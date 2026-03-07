import generate from "@babel/generator";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
  TraceMap,
  generatedPositionFor,
} from "@jridgewell/trace-mapping";

function resolveGeneratedLine(
  traceMap: TraceMap | null,
  sourceName: string,
  location: { line: number; column: number } | null | undefined,
): number | null {
  if (!traceMap || !location) {
    return null;
  }

  const sources = [sourceName, ...traceMap.sources]
    .filter((source): source is string => Boolean(source))
    .filter((source, index, array) => array.indexOf(source) === index);

  for (const source of sources) {
    try {
      const generated = generatedPositionFor(traceMap, {
        source,
        line: location.line,
        column: location.column,
      });
      if (generated.line !== null && generated.line > 0) {
        return generated.line;
      }
    } catch {
      // Try next possible source key.
    }
  }

  return null;
}

function fallbackGeneratedLineFromCode(prettySource: string, node: t.Node): number | null {
  let generatedNode = "";
  try {
    generatedNode = generate(node, {
      comments: false,
      compact: false,
      jsescOption: { minimal: true },
    }).code;
  } catch {
    return null;
  }

  const needle = generatedNode
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!needle) {
    return null;
  }

  const index = prettySource.indexOf(needle);
  if (index < 0) {
    return null;
  }

  return prettySource.slice(0, index).split(/\r?\n/).length;
}

export function buildCodeSnippet(
  prettySource: string,
  prettyLines: string[],
  traceMap: TraceMap | null,
  sourceName: string,
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
): string | undefined {
  const statementPath = sinkPath.findParent((parentPath) =>
    parentPath.isStatement(),
  ) as NodePath<t.Statement> | null;
  const ownerFunction = sinkPath.findParent((parentPath) =>
    parentPath.isFunction(),
  ) as NodePath<t.Function> | null;

  const focusNode = statementPath?.node ?? sinkPath.node;
  const contextNode = ownerFunction?.node ?? focusNode;

  const fallbackLine =
    fallbackGeneratedLineFromCode(prettySource, focusNode) ??
    fallbackGeneratedLineFromCode(prettySource, sinkPath.node) ??
    1;

  const resolvedFocusLine =
    resolveGeneratedLine(traceMap, sourceName, focusNode.loc?.start) ?? fallbackLine;

  let contextStartLine =
    resolveGeneratedLine(traceMap, sourceName, contextNode.loc?.start) ?? 1;
  let contextEndLine =
    resolveGeneratedLine(traceMap, sourceName, contextNode.loc?.end) ?? prettyLines.length;

  if (contextStartLine > contextEndLine) {
    const temp = contextStartLine;
    contextStartLine = contextEndLine;
    contextEndLine = temp;
  }

  contextStartLine = Math.max(1, Math.min(contextStartLine, prettyLines.length));
  contextEndLine = Math.max(1, Math.min(contextEndLine, prettyLines.length));

  const focusLine = Math.max(1, Math.min(resolvedFocusLine, prettyLines.length));

  if (focusLine < contextStartLine || focusLine > contextEndLine) {
    contextStartLine = 1;
    contextEndLine = prettyLines.length;
  }

  const lineWindow = 26;
  const before = Math.floor((lineWindow - 1) / 2);
  let startLine = Math.max(contextStartLine, focusLine - before);
  let endLine = Math.min(contextEndLine, startLine + lineWindow - 1);

  if (endLine - startLine + 1 < lineWindow) {
    startLine = Math.max(contextStartLine, endLine - lineWindow + 1);
  }

  const chunk = prettyLines.slice(startLine - 1, endLine);
  while (chunk.length > 0 && chunk[0].trim().length === 0) {
    chunk.shift();
    startLine += 1;
  }
  while (chunk.length > 0 && chunk[chunk.length - 1].trim().length === 0) {
    chunk.pop();
    endLine -= 1;
  }

  if (chunk.length === 0) {
    return undefined;
  }

  const output: string[] = [];
  if (startLine > contextStartLine) {
    output.push("...");
  }
  output.push(...chunk);
  if (endLine < contextEndLine) {
    output.push("...");
  }

  return output.join("\n");
}
