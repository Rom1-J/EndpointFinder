import path from "node:path";
import { analyzeSource, type AnalyzeSourceOptions } from "./analyzeFile";
import { collectWebpackExternalModulesFromSources } from "./webpackRegistry";
import type { AnalyzeProjectResult, AnalysisError, Finding } from "../types";
import {
  cloneSiteSources,
  collectSiteSources,
  type CollectSiteSourcesOptions,
} from "../web/siteSourceCollector";
import { elapsedMs, nowMs } from "../utils/perf";

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
  const totalStart = nowMs();
  const sourceCollectionStart = nowMs();
  const collected = await collectSiteSources(targetUrl, {
    fetchImpl: options.fetchImpl,
    maxRemoteFiles: options.maxRemoteFiles,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    sameOriginOnly: options.sameOriginOnly,
  });
  const sourceCollectionMs = elapsedMs(sourceCollectionStart);

  let sourcePathByUrl = new Map<string, string>();
  let clonedTo: string | undefined;
  let cloneMs: number | undefined;

  if (options.siteMode === "clone") {
    const cloneStart = nowMs();
    const cloneDir = path.resolve(options.cloneDir ?? "site-clone");
    const cloned = await cloneSiteSources(collected, cloneDir);
    cloneMs = elapsedMs(cloneStart);
    clonedTo = cloned.rootDir;
    sourcePathByUrl = new Map(cloned.sourceFiles.map((item) => [item.url, item.filePath]));
  }

  const findings: Finding[] = [];
  const errors: AnalysisError[] = [...collected.errors];

  const webpackRegistryStart = nowMs();
  const webpackExternalModulesById = collectWebpackExternalModulesFromSources(
    collected.sources.map((source) => ({
      id: source.url,
      source: source.content,
    })),
  );
  const webpackRegistryMs = elapsedMs(webpackRegistryStart);

  const fileTimings: NonNullable<AnalyzeProjectResult["timings"]>["fileTimings"] = [];

  for (const source of collected.sources) {
    const sourcePath = sourcePathByUrl.get(source.url) ?? source.url;
    const result = analyzeSource(source.content, sourcePath, {
      sinkDefinitions: options.sinkDefinitions,
      includeUnresolved: options.includeUnresolved,
      maxDepth: options.maxDepth,
      profile: options.profile,
      webpackExternalModulesById,
    });

    findings.push(...result.findings);
    if (result.timing) {
      fileTimings.push(result.timing);
    }
    errors.push(
      ...result.errors.map((message) => ({
        file: sourcePath,
        message,
      })),
    );
  }

  const timings = options.profile
    ? {
        totalMs: elapsedMs(totalStart),
        parseMs: fileTimings.reduce((sum, timing) => sum + timing.parseMs, 0),
        analysisMs: fileTimings.reduce((sum, timing) => sum + timing.analysisMs, 0),
        resolverMs: fileTimings.reduce((sum, timing) => sum + timing.resolverMs, 0),
        fileCount: fileTimings.length,
        fileTimings,
        sourceCollectionMs,
        cloneMs,
        webpackRegistryMs,
      }
    : undefined;

  return {
    target: collected.entryUrl,
    filesAnalyzed: collected.sources.length,
    findings,
    errors,
    sourceMode: options.siteMode === "clone" ? "url-clone" : "url-direct",
    clonedTo,
    timings,
  };
}
