import path from "node:path";
import type { AnalyzeProjectResult, Finding } from "../../types";

export function pluralize(word: string, count: number): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function toDisplayPath(filePath: string, cwd: string): string {
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

export function groupFindingsByFile(findings: Finding[]): Map<string, Finding[]> {
  const grouped = new Map<string, Finding[]>();
  for (const finding of sortFindings(findings)) {
    const list = grouped.get(finding.file) ?? [];
    list.push(finding);
    grouped.set(finding.file, list);
  }
  return grouped;
}

export function groupErrorsByFile(
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
