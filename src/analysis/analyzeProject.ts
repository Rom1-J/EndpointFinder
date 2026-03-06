import { stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AnalyzeProjectResult } from "../types";
import { analyzeFile, type AnalyzeSourceOptions } from "./analyzeFile";
import { collectWebpackExternalModules } from "./webpackRegistry";
import { normalizeFilePath } from "../utils/ast";

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
  const files = await collectSourceFiles(targetPath);
  const webpackExternalModulesById = await collectWebpackExternalModules(files);
  const findings = [];
  const errors = [];

  for (const filePath of files) {
    const result = await analyzeFile(filePath, {
      ...options,
      webpackExternalModulesById,
    });
    findings.push(...result.findings);
    errors.push(
      ...result.errors.map((message) => ({
        file: normalizeFilePath(filePath),
        message,
      })),
    );
  }

  return {
    target: normalizeFilePath(path.resolve(targetPath)),
    filesAnalyzed: files.length,
    findings,
    errors,
    sourceMode: "local",
  };
}
