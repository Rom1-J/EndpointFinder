import type { AnalyzeProjectResult } from "../types";

export function toJsonReport(result: AnalyzeProjectResult): string {
  return JSON.stringify(result, null, 2);
}
