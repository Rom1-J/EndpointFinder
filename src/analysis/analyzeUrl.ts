import path from "node:path";
import { analyzeSource, type AnalyzeSourceOptions } from "./analyzeFile";
import { collectWebpackExternalModulesFromSources } from "./webpackRegistry";
import type { AnalyzeProjectResult } from "../types";
import {
  cloneSiteSources,
  collectSiteSources,
  type CollectSiteSourcesOptions,
} from "../web/siteSourceCollector";

export interface AnalyzeUrlOptions
  extends AnalyzeSourceOptions,
    CollectSiteSourcesOptions {
  siteMode?: "direct" | "clone";
  cloneDir?: string;
}

export async function analyzeUrlTarget(
  targetUrl: string,
  options: AnalyzeUrlOptions = {},
): Promise<AnalyzeProjectResult> {
  const collected = await collectSiteSources(targetUrl, {
    fetchImpl: options.fetchImpl,
    maxRemoteFiles: options.maxRemoteFiles,
    timeoutMs: options.timeoutMs,
    sameOriginOnly: options.sameOriginOnly,
  });

  let sourcePathByUrl = new Map<string, string>();
  let clonedTo: string | undefined;

  if (options.siteMode === "clone") {
    const cloneDir = path.resolve(options.cloneDir ?? "site-clone");
    const cloned = await cloneSiteSources(collected, cloneDir);
    clonedTo = cloned.rootDir;
    sourcePathByUrl = new Map(cloned.sourceFiles.map((item) => [item.url, item.filePath]));
  }

  const findings = [];
  const errors = [...collected.errors];
  const webpackExternalModulesById = collectWebpackExternalModulesFromSources(
    collected.sources.map((source) => ({
      id: source.url,
      source: source.content,
    })),
  );

  for (const source of collected.sources) {
    const sourcePath = sourcePathByUrl.get(source.url) ?? source.url;
    const result = analyzeSource(source.content, sourcePath, {
      sinkDefinitions: options.sinkDefinitions,
      includeUnresolved: options.includeUnresolved,
      maxDepth: options.maxDepth,
      webpackExternalModulesById,
    });

    findings.push(...result.findings);
    errors.push(
      ...result.errors.map((message) => ({
        file: sourcePath,
        message,
      })),
    );
  }

  return {
    target: collected.entryUrl,
    filesAnalyzed: collected.sources.length,
    findings,
    errors,
    sourceMode: options.siteMode === "clone" ? "url-clone" : "url-direct",
    clonedTo,
  };
}
