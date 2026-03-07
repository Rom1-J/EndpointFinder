import type { AnalyzeProjectResult } from "../types";
import { toBurpExport } from "./export/burp";
import { toPostmanExport } from "./export/postman";
import { toSwaggerExport } from "./export/swagger";
import type { ExportFormat } from "./export/types";

export type { ExportFormat };

export function toExportReport(
  result: AnalyzeProjectResult,
  format: ExportFormat,
): string {
  if (format === "swagger") {
    return toSwaggerExport(result);
  }
  if (format === "postman") {
    return toPostmanExport(result);
  }
  return toBurpExport(result);
}
