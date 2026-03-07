import { parseCode, parseFile } from "../parser/parseFile";
import type { ResolvedValue } from "../resolver/valueModel";
import { mapWithConcurrency, normalizeConcurrency } from "../utils/concurrency";
import {
  collectWebpackExternalModulesFromAst,
  type ExternalWebpackRegistry,
} from "./webpack/moduleDiscovery";

function mergeRegistryModules(
  target: Map<string, Record<string, ResolvedValue>>,
  source: ExternalWebpackRegistry,
): void {
  for (const [moduleId, exports] of source) {
    const existing = target.get(moduleId) ?? {};
    target.set(moduleId, {
      ...existing,
      ...exports,
    });
  }
}

export type { ExternalWebpackRegistry };

export async function collectWebpackExternalModulesFromFile(
  filePath: string,
): Promise<ExternalWebpackRegistry> {
  const parsed = await parseFile(filePath);
  if (!parsed.ast) {
    return new Map();
  }

  return collectWebpackExternalModulesFromAst(parsed.ast);
}

export function collectWebpackExternalModulesFromSources(
  sources: Array<{ id: string; source: string }>,
): ExternalWebpackRegistry {
  const merged = new Map<string, Record<string, ResolvedValue>>();

  for (const source of sources) {
    const parsed = parseCode(source.source, source.id);
    if (!parsed.ast) {
      continue;
    }
    const modules = collectWebpackExternalModulesFromAst(parsed.ast);
    mergeRegistryModules(merged, modules);
  }

  return merged;
}

export async function collectWebpackExternalModules(
  filePaths: string[],
  concurrency?: number,
): Promise<ExternalWebpackRegistry> {
  const merged = new Map<string, Record<string, ResolvedValue>>();
  const parallelism = normalizeConcurrency(concurrency);

  const fileModuleResults = await mapWithConcurrency(
    filePaths,
    parallelism,
    (filePath) => collectWebpackExternalModulesFromFile(filePath),
  );

  for (const fileModules of fileModuleResults) {
    mergeRegistryModules(merged, fileModules);
  }

  return merged;
}
