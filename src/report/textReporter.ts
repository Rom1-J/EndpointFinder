import path from "node:path";
import highlight from "@babel/highlight";
import type { AnalyzeProjectResult, Finding } from "../types";

interface TextReportOptions {
  color?: boolean;
  cwd?: string;
  maxSnippetLength?: number;
  maxTraceSteps?: number;
  maxCodeLines?: number;
}

interface Theme {
  bold(text: string): string;
  dim(text: string): string;
  cyan(text: string): string;
  blue(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  magenta(text: string): string;
}

const ANSI_REGEX = /\u001b\[[0-9;]*m/g;

function useColorByDefault(): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  if (process.env.FORCE_COLOR === "0") {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return Boolean(process.stdout.isTTY);
}

function makeTheme(colorEnabled: boolean): Theme {
  const wrap = (code: string) =>
    colorEnabled
      ? (text: string) => `\u001b[${code}m${text}\u001b[0m`
      : (text: string) => text;

  return {
    bold: wrap("1"),
    dim: wrap("2"),
    cyan: wrap("36"),
    blue: wrap("34"),
    green: wrap("32"),
    yellow: wrap("33"),
    red: wrap("31"),
    magenta: wrap("35"),
  };
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function padRightAnsi(text: string, plain: string, width: number): string {
  const missing = Math.max(0, width - plain.length);
  return `${text}${" ".repeat(missing)}`;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function wrapLine(value: string, width: number): string[] {
  if (width <= 4) {
    return [value.slice(0, width)];
  }

  const lines: string[] = [];
  const input = value.trimEnd();
  if (input.length === 0) {
    return [""];
  }

  let cursor = 0;
  while (cursor < input.length) {
    const remaining = input.slice(cursor);
    if (remaining.length <= width) {
      lines.push(remaining);
      break;
    }

    const slice = remaining.slice(0, width + 1);
    const breakAt = slice.lastIndexOf(" ");
    if (breakAt <= 0) {
      lines.push(remaining.slice(0, width));
      cursor += width;
      continue;
    }

    lines.push(remaining.slice(0, breakAt));
    cursor += breakAt + 1;
  }

  return lines;
}

function pluralize(word: string, count: number): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function toDisplayPath(filePath: string, cwd: string): string {
  if (/^https?:\/\//i.test(filePath)) {
    return filePath;
  }
  const relative = path.relative(cwd, filePath);
  if (!relative || relative.startsWith("..")) {
    return filePath;
  }
  return relative.replace(/\\/g, "/");
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    if (left.file !== right.file) {
      return left.file.localeCompare(right.file);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.column - right.column;
  });
}

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

function findingTable(
  finding: Finding,
  index: number,
  theme: Theme,
  options: {
    colorEnabled: boolean;
    width: number;
    maxSnippetLength: number;
    maxTraceSteps: number;
    maxCodeLines: number;
  },
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

function groupFindingsByFile(findings: Finding[]): Map<string, Finding[]> {
  const grouped = new Map<string, Finding[]>();
  for (const finding of sortFindings(findings)) {
    const list = grouped.get(finding.file) ?? [];
    list.push(finding);
    grouped.set(finding.file, list);
  }
  return grouped;
}

function groupErrorsByFile(
  errors: AnalyzeProjectResult["errors"],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  const sorted = [...errors].sort((left, right) => left.file.localeCompare(right.file));
  for (const error of sorted) {
    const list = grouped.get(error.file) ?? [];
    list.push(error.message);
    grouped.set(error.file, list);
  }
  return grouped;
}

export function toTextReport(
  result: AnalyzeProjectResult,
  options: TextReportOptions = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const colorEnabled = options.color ?? useColorByDefault();
  const theme = makeTheme(colorEnabled);
  const maxSnippetLength = options.maxSnippetLength ?? 900;
  const maxTraceSteps = options.maxTraceSteps ?? 8;
  const maxCodeLines = options.maxCodeLines ?? 14;
  const width = process.stdout.columns ?? 120;
  const lines: string[] = [];

  const targetName = path.basename(result.target);
  lines.push(theme.bold(theme.cyan("Endpoint Analysis")));
  lines.push(
    `${pluralize("file", result.filesAnalyzed)} analyzed in ${theme.bold(targetName)} | ${theme.bold(
      pluralize("endpoint", result.findings.length),
    )} found`,
  );

  if (result.sourceMode === "url-direct") {
    lines.push(`${theme.dim("Source mode:")} ${theme.blue("remote direct")} ${result.target}`);
  } else if (result.sourceMode === "url-clone") {
    lines.push(`${theme.dim("Source mode:")} ${theme.blue("remote clone")} ${result.target}`);
    if (result.clonedTo) {
      lines.push(`${theme.dim("Cloned to:")} ${toDisplayPath(result.clonedTo, cwd)}`);
    }
  }

  const groupedFindings = groupFindingsByFile(result.findings);
  if (groupedFindings.size > 0) {
    lines.push("");
    for (const [filePath, fileFindings] of groupedFindings) {
      const displayPath = toDisplayPath(filePath, cwd);
      lines.push(theme.bold(theme.cyan(`==> ${displayPath} (${pluralize("endpoint", fileFindings.length)}) <==`)));
      lines.push("");

      fileFindings.forEach((finding, index) => {
        lines.push(
          ...findingTable(finding, index + 1, theme, {
            colorEnabled,
            width,
            maxSnippetLength,
            maxTraceSteps,
            maxCodeLines,
          }),
        );
        lines.push("");
      });
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
  }

  if (result.errors.length > 0) {
    lines.push("");
    lines.push(theme.bold(theme.yellow(`Warnings (${result.errors.length})`)));

    const groupedErrors = groupErrorsByFile(result.errors);
    for (const [filePath, messages] of groupedErrors) {
      const displayPath = toDisplayPath(filePath, cwd);
      lines.push(theme.bold(theme.yellow(`==> ${displayPath} <==`)));
      for (const message of messages) {
        lines.push(`  - ${theme.red(message)}`);
      }
    }
  }

  return lines.join("\n");
}
