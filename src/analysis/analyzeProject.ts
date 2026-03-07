import { stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AnalyzeProjectResult, AnalysisError, Finding } from "../types";
import { analyzeFile, type AnalyzeSourceOptions } from "./analyzeFile";
import { collectWebpackExternalModules } from "./webpackRegistry";
import { normalizeFilePath } from "../utils/ast";
import { mapWithConcurrency, normalizeConcurrency } from "../utils/concurrency";
import { elapsedMs, nowMs } from "../utils/perf";

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

async function collectSourceFiles(targetPath: string): Promise<string[]> {
  const absoluteTarget = path.resolve(targetPath);
  const targetStat = await stat(absoluteTarget);

  if (targetStat.isFile()) {
    const extension = path.extname(absoluteTarget).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) {
      return [];
    }
    return [absoluteTarget];
  }

  if (!targetStat.isDirectory()) {
    return [];
  }

  const files = await fg(["**/*.{js,mjs,cjs,ts,tsx,jsx}"], {
    cwd: absoluteTarget,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/*.d.ts"],
  });

  return files;
}

export async function analyzeProject(
  targetPath: string,
  options: AnalyzeSourceOptions = {},
): Promise<AnalyzeProjectResult> {
  const totalStart = nowMs();
  const files = await collectSourceFiles(targetPath);

  const registryStart = nowMs();
  const webpackExternalModulesById = await collectWebpackExternalModules(
    files,
    options.concurrency,
  );
  const webpackRegistryMs = elapsedMs(registryStart);

  const findings: Finding[] = [];
  const errors: AnalysisError[] = [];
  const concurrency = normalizeConcurrency(options.concurrency);

  const fileResults = await mapWithConcurrency(
    files,
    concurrency,
    async (filePath) =>
      analyzeFile(filePath, {
        ...options,
        webpackExternalModulesById,
      }),
  );

  fileResults.forEach((result, index) => {
    const filePath = files[index];
    findings.push(...result.findings);
    errors.push(
      ...result.errors.map((message) => ({
        file: normalizeFilePath(filePath),
        message,
      })),
    );
  });

  const fileTimings = fileResults
    .map((result) => result.timing)
    .filter((timing): timing is NonNullable<typeof fileResults[number]["timing"]> =>
      Boolean(timing),
    );

  const timings = options.profile
    ? {
        totalMs: elapsedMs(totalStart),
        parseMs: fileTimings.reduce((sum, timing) => sum + timing.parseMs, 0),
        analysisMs: fileTimings.reduce((sum, timing) => sum + timing.analysisMs, 0),
        resolverMs: fileTimings.reduce((sum, timing) => sum + timing.resolverMs, 0),
        fileCount: fileTimings.length,
        fileTimings,
        webpackRegistryMs,
      }
    : undefined;

  return {
    target: normalizeFilePath(path.resolve(targetPath)),
    filesAnalyzed: files.length,
    findings,
    errors,
    sourceMode: "local",
    timings,
  };
}
