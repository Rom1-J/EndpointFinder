import type { Finding } from "../../types";

export type ExportFormat = "swagger" | "postman" | "burp";

export interface ExportEndpoint {
  finding: Finding;
  method: string;
  urlRaw: string;
  headers: Array<{ name: string; value: string }>;
  body: string | null;
}
