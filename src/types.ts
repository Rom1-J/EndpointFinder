export type Confidence = "high" | "medium" | "low";

export interface FindingHeader {
  name: string;
  value: string | null;
  valueTemplate: string | null;
  confidence: Confidence;
}

export interface FindingBody {
  value: string | null;
  valueTemplate: string | null;
  confidence: Confidence;
}

export interface Finding {
  file: string;
  line: number;
  column: number;
  sink: string;
  method: string | null;
  url: string | null;
  urlTemplate: string | null;
  confidence: Confidence;
  resolutionTrace: string[];
  codeSnippet?: string;
  headers?: FindingHeader[];
  body?: FindingBody | null;
}

export interface AnalysisError {
  file: string;
  message: string;
}

export interface AnalyzeFileResult {
  file: string;
  findings: Finding[];
  errors: string[];
}

export interface AnalyzeProjectResult {
  target: string;
  filesAnalyzed: number;
  findings: Finding[];
  errors: AnalysisError[];
  sourceMode?: "local" | "url-direct" | "url-clone";
  clonedTo?: string;
}
