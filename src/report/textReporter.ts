import path from "node:path";
import type { AnalyzeProjectResult } from "../types";
import { findingTable } from "./text/findingTable";
import {
  groupErrorsByFile,
  groupFindingsByFile,
  pluralize,
  toDisplayPath,
} from "./text/grouping";
import { makeTheme, useColorByDefault } from "./text/theme";

interface TextReportOptions {
  color?: boolean;
  cwd?: string;
  maxSnippetLength?: number;
  maxTraceSteps?: number;
  maxCodeLines?: number;
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
