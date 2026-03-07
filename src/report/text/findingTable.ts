import highlight from "@babel/highlight";
import type { Finding } from "../../types";
import { padRightAnsi, stripAnsi, truncateText, wrapLine } from "./layout";
import type { Theme } from "./theme";

function confidenceBadge(confidence: Finding["confidence"], theme: Theme): string {
  const label = confidence.toUpperCase();
  if (confidence === "high") {
    return theme.green(label);
  }
  if (confidence === "medium") {
    return theme.yellow(label);
  }
  return theme.red(label);
}

function targetLine(finding: Finding): { label: string; value: string } {
  if (finding.url !== null) {
    return {
      label: "URL",
      value: finding.url.length > 0 ? finding.url : "<empty-url>",
    };
  }
  if (finding.urlTemplate !== null) {
    return {
      label: "Template",
      value: finding.urlTemplate.length > 0 ? finding.urlTemplate : "<empty-template>",
    };
  }
  return {
    label: "Target",
    value: "<unresolved>",
  };
}

function metadataValue(value: string | null, template: string | null): string {
  if (value !== null) {
    return value;
  }
  if (template !== null) {
    return template;
  }
  return "<unknown>";
}

function formatTrace(finding: Finding, maxTraceSteps: number): string {
  const trace = finding.resolutionTrace;
  if (trace.length === 0) {
    return "Trace: <none>";
  }

  const budget = Math.max(3, maxTraceSteps);
  if (trace.length <= budget) {
    return `Trace: ${trace.join(" -> ")}`;
  }

  const preserved = Math.max(2, budget - 1);
  const headCount = Math.ceil(preserved / 2);
  const tailCount = Math.floor(preserved / 2);
  const head = trace.slice(0, headCount);
  const tail = tailCount > 0 ? trace.slice(trace.length - tailCount) : [];
  const summarized = [...head, "...", ...tail];

  return `Trace: ${summarized.join(" -> ")}`;
}

function beautifySnippet(snippet: string, maxLines: number): string[] {
  if (!snippet || snippet.trim().length === 0) {
    return ["<no snippet>"];
  }

  const rawLines = snippet
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "  ").replace(/\s+$/g, ""));

  while (rawLines.length > 0 && rawLines[0].trim().length === 0) {
    rawLines.shift();
  }
  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim().length === 0) {
    rawLines.pop();
  }

  if (rawLines.length === 0) {
    return ["<no snippet>"];
  }

  const limit = Math.max(1, maxLines);
  if (rawLines.length <= limit) {
    return rawLines;
  }

  const sinkLineIndex = rawLines.findIndex((line) =>
    /\b(fetch|axios|XMLHttpRequest|sendBeacon|WebSocket|EventSource|Request)\b/.test(
      line,
    ),
  );

  const center = sinkLineIndex >= 0 ? sinkLineIndex : Math.floor(rawLines.length / 2);
  const windowBefore = Math.floor((limit - 1) / 2);
  let start = Math.max(0, center - windowBefore);
  let end = Math.min(rawLines.length, start + limit);
  if (end - start < limit) {
    start = Math.max(0, end - limit);
  }

  const output = rawLines.slice(start, end);
  if (start > 0 && output[0] !== "...") {
    output.unshift("...");
  }
  if (end < rawLines.length && output[output.length - 1] !== "...") {
    output.push("...");
  }

  return output;
}

function colorizeSnippetLine(line: string, colorEnabled: boolean): string {
  if (!colorEnabled) {
    return line;
  }
  try {
    return highlight(line, {
      forceColor: true,
      compact: false,
    });
  } catch {
    return line;
  }
}

function detailLines(finding: Finding): string[] {
  const lines: string[] = [];
  const target = targetLine(finding);

  lines.push(`Method: ${finding.method ?? "UNKNOWN"}`);
  lines.push(`${target.label}: ${target.value}`);

  if (finding.headers && finding.headers.length > 0) {
    lines.push("Headers:");
    for (const header of finding.headers) {
      lines.push(`- ${header.name}: ${metadataValue(header.value, header.valueTemplate)}`);
    }
  }

  if (finding.body) {
    lines.push(`Body: ${metadataValue(finding.body.value, finding.body.valueTemplate)}`);
  }

  return lines;
}

function findingTitle(finding: Finding, index: number, theme: Theme): string {
  const method = finding.method ? ` ${finding.method}` : "";
  const base = `${String(index).padStart(2, "0")}. ${finding.line}:${finding.column} ${finding.sink}${method}`;
  return `${theme.bold(base)} [${confidenceBadge(finding.confidence, theme)}]`;
}

export interface FindingTableOptions {
  colorEnabled: boolean;
  width: number;
  maxSnippetLength: number;
  maxTraceSteps: number;
  maxCodeLines: number;
}

export function findingTable(
  finding: Finding,
  index: number,
  theme: Theme,
  options: FindingTableOptions,
): string[] {
  const totalWidth = Math.max(96, options.width - 2);
  let leftWidth = Math.max(46, Math.floor(totalWidth * 0.6));
  let rightWidth = totalWidth - leftWidth - 9;
  if (rightWidth < 38) {
    rightWidth = 38;
    leftWidth = Math.max(36, totalWidth - rightWidth - 9);
  }

  const spanWidth = leftWidth + rightWidth + 5;
  const titleWidth = spanWidth - 2;
  const border = (value: string) =>
    options.colorEnabled ? theme.cyan(value) : value;

  const snippetSource =
    (finding.codeSnippet ?? "<no snippet>").length > options.maxSnippetLength
      ? `${(finding.codeSnippet ?? "<no snippet>").slice(0, options.maxSnippetLength)}\n...`
      : (finding.codeSnippet ?? "<no snippet>");
  const snippetLinesRaw = beautifySnippet(snippetSource, options.maxCodeLines);
  const snippetWrapped: Array<{ plain: string; colored: string }> = [];
  for (const rawLine of snippetLinesRaw) {
    const wrapped = wrapLine(rawLine, leftWidth);
    for (const line of wrapped) {
      snippetWrapped.push({
        plain: line,
        colored: colorizeSnippetLine(line, options.colorEnabled),
      });
    }
  }
  if (snippetWrapped.length === 0) {
    snippetWrapped.push({ plain: "<no snippet>", colored: "<no snippet>" });
  }

  const rightLinesRaw = detailLines(finding);
  const rightWrapped: string[] = [];
  for (const rawLine of rightLinesRaw) {
    rightWrapped.push(...wrapLine(rawLine, rightWidth));
  }

  const rowCount = Math.max(snippetWrapped.length, rightWrapped.length, 1);
  const lines: string[] = [];

  lines.push(`${border("┌")}${border("─".repeat(spanWidth))}${border("┐")}`);

  const title = truncateText(stripAnsi(findingTitle(finding, index, theme)), titleWidth);
  const coloredTitle = findingTitle(finding, index, theme);
  lines.push(
    `${border("│")} ${padRightAnsi(coloredTitle, title, titleWidth)} ${border("│")}`,
  );

  lines.push(
    `${border("├")}${border("─".repeat(leftWidth + 2))}${border("┬")}${border(
      "─".repeat(rightWidth + 2),
    )}${border("┤")}`,
  );

  for (let row = 0; row < rowCount; row += 1) {
    const left = snippetWrapped[row] ?? { plain: "", colored: "" };
    const rightPlain = rightWrapped[row] ?? "";
    const rightColored =
      rightPlain.startsWith("Method:")
        ? `Method: ${theme.blue(rightPlain.slice("Method:".length).trim())}`
        : rightPlain.startsWith("URL:")
          ? `URL: ${theme.green(rightPlain.slice("URL:".length).trim())}`
          : rightPlain.startsWith("Template:")
            ? `Template: ${theme.yellow(rightPlain.slice("Template:".length).trim())}`
            : rightPlain.startsWith("Body:")
              ? `Body: ${theme.magenta(rightPlain.slice("Body:".length).trim())}`
              : rightPlain.startsWith("Headers:")
                ? theme.bold(rightPlain)
                : rightPlain.startsWith("- ")
                  ? `- ${theme.dim(rightPlain.slice(2))}`
                  : rightPlain;

    lines.push(
      `${border("│")} ${padRightAnsi(left.colored, left.plain, leftWidth)} ${border(
        "│",
      )} ${padRightAnsi(rightColored, rightPlain, rightWidth)} ${border("│")}`,
    );
  }

  lines.push(`${border("├")}${border("─".repeat(spanWidth))}${border("┤")}`);
  const traceText = formatTrace(finding, options.maxTraceSteps);
  const traceLines = wrapLine(traceText, spanWidth - 2);
  for (const line of traceLines) {
    lines.push(
      `${border("│")} ${padRightAnsi(theme.dim(line), line, spanWidth - 2)} ${border("│")}`,
    );
  }

  lines.push(`${border("└")}${border("─".repeat(spanWidth))}${border("┘")}`);
  return lines;
}
