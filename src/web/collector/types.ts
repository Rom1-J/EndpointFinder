import type { AnalysisError } from "../../types";

export interface RemoteSourceFile {
  url: string;
  content: string;
  contentType: string | null;
}

export interface CollectedSiteSources {
  entryUrl: string;
  entryHtml: string;
  sources: RemoteSourceFile[];
  errors: AnalysisError[];
}

export interface ClonedSiteSources {
  rootDir: string;
  manifestFile: string;
  entryHtmlFile: string | null;
  sourceFiles: Array<{
    url: string;
    filePath: string;
  }>;
}

export interface CollectSiteSourcesOptions {
  fetchImpl?: typeof fetch;
  maxRemoteFiles?: number;
  timeoutMs?: number;
  concurrency?: number;
  sameOriginOnly?: boolean;
}
