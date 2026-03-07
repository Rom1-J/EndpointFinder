import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import { TraceMap } from "@jridgewell/trace-mapping";
import { parseCode, parseFile } from "../parser/parseFile";
import { renderValue } from "../resolver/renderValue";
import type { ResolverContext } from "../resolver/types";
import { joinBaseAndPath, type ResolvedValue } from "../resolver/valueModel";
import { builtinSinks } from "../sinks/builtinSinks";
import { matchSink } from "../sinks/matchSink";
import type { SinkDefinition } from "../sinks/sinkConfig";
import type { AnalyzeFileResult, FileAnalysisTiming, Finding } from "../types";
import { dedupeTrace, normalizeFilePath } from "../utils/ast";
import { elapsedMs, nowMs } from "../utils/perf";
import { resolveAxiosCall, resolveAxiosMethodBaseURL, resolveFetchLikeMethod, toHttpMethod } from "./file/methodResolution";
import { extractRequestMetadata } from "./file/requestMetadata";
import { collectResolverIndexes } from "./file/resolverIndexes";
import { buildCodeSnippet } from "./file/snippet";
import { shouldAttemptIndirectResolution } from "./file/sinkPruning";
import { createTopLevelResolver } from "./file/topLevelResolver";
import {
  augmentIndirectCallSites,
  buildGlobalSymbolValues,
  resolveCallArgumentByIndex,
  resolveIndirectSinkTargets,
  type ResolvedSinkTarget,
} from "./file/sinkTargets";

export interface AnalyzeSourceOptions {
  sinkDefinitions?: SinkDefinition[];
  includeUnresolved?: boolean;
  maxDepth?: number;
  profile?: boolean;
  concurrency?: number;
  webpackExternalModulesById?: Map<string, Record<string, ResolvedValue>>;
}

interface AnalyzeAstResult {
  findings: Finding[];
  analysisMs: number;
  resolverMs: number;
  resolverCalls: number;
  resolverCacheHits: number;
}

function analyzeAst(
  ast: t.File,
  source: string,
  filePath: string,
  options: AnalyzeSourceOptions,
): AnalyzeAstResult {
  const analysisStart = nowMs();
  const sinkDefinitions = options.sinkDefinitions ?? builtinSinks;
  const includeUnresolved = options.includeUnresolved ?? false;
  const normalizedFilePath = normalizeFilePath(filePath);
  const prettySourceName = normalizedFilePath;

  const indexes = collectResolverIndexes(ast);
  const globalSymbolValues = buildGlobalSymbolValues(sinkDefinitions);
  const resolverContext: ResolverContext = {
    callSitesByFunction: indexes.callSitesByFunction,
    functionPaths: indexes.functionPaths,
    webpackModulesById: indexes.webpackModulesById,
    webpackModuleByFunction: indexes.webpackModuleByFunction,
    webpackExternalModulesById:
      options.webpackExternalModulesById ?? new Map<string, Record<string, ResolvedValue>>(),
    globalSymbolValues,
    memberAssignments: indexes.memberAssignments,
    maxDepth: options.maxDepth ?? 12,
  };

  const resolver = createTopLevelResolver(resolverContext);
  augmentIndirectCallSites(
    indexes.callExpressions,
    resolverContext,
    resolver.resolveUncached,
  );
  resolver.clearCache();

  const resolve = resolver.resolve;

  let snippetContext:
    | {
        prettySource: string;
        prettyLines: string[];
        prettyTraceMap: TraceMap | null;
      }
    | null = null;

  const ensureSnippetContext = () => {
    if (snippetContext) {
      return snippetContext;
    }

    const prettyGenerated = (() => {
      try {
        return generate(
          ast,
          {
            comments: false,
            compact: false,
            sourceMaps: true,
            sourceFileName: prettySourceName,
            jsescOption: { minimal: true },
          },
          source,
        );
      } catch {
        return null;
      }
    })();

    const prettySource = prettyGenerated?.code ?? source;
    snippetContext = {
      prettySource,
      prettyLines: prettySource.split(/\r?\n/),
      prettyTraceMap: prettyGenerated?.map
        ? new TraceMap(prettyGenerated.map as any)
        : null,
    };

    return snippetContext;
  };

  const findings: Finding[] = [];

  const processSink = (path: NodePath<t.CallExpression> | NodePath<t.NewExpression>) => {
    const matched = matchSink(path, {
      sinkDefinitions,
      resolveExpression: resolve,
    });
    const targets: ResolvedSinkTarget[] = [];

    if (matched) {
      targets.push({
        definition: matched.definition,
        baseURL: matched.baseURL,
        indirectTrace: [],
      });
    } else if (shouldAttemptIndirectResolution(path)) {
      targets.push(...resolveIndirectSinkTargets(path, resolve));
    }

    if (targets.length === 0) {
      return;
    }

    for (const target of targets) {
      let urlValue: ResolvedValue | null = null;
      let method: string | null = target.definition.httpMethod ?? null;
      const trace: string[] = [...target.indirectTrace];

      if (target.definition.match === "axios" && path.isCallExpression()) {
        const axiosResolved = resolveAxiosCall(path, resolve);
        urlValue = axiosResolved.urlValue;
        method = method ?? axiosResolved.method;
        trace.push(...axiosResolved.trace);
      } else {
        const urlResolved = resolveCallArgumentByIndex(path, target.definition.urlArg, resolve);
        if (urlResolved) {
          urlValue = urlResolved.value;
          trace.push(...urlResolved.trace);
        }
      }

      if (target.baseURL && urlValue) {
        urlValue = joinBaseAndPath(target.baseURL, urlValue);
        trace.push("Join(baseURL,path)");
      }

      if (
        !target.baseURL &&
        typeof target.definition.baseURLArg === "number" &&
        urlValue
      ) {
        const baseArgResolved = resolveCallArgumentByIndex(
          path,
          target.definition.baseURLArg,
          resolve,
        );
        if (baseArgResolved) {
          urlValue = joinBaseAndPath(baseArgResolved.value, urlValue);
          trace.push(...baseArgResolved.trace);
          trace.push("Join(baseURLArg,path)");
        }
      }

      if (
        !target.baseURL &&
        target.definition.match.startsWith("axios.") &&
        path.isCallExpression() &&
        urlValue
      ) {
        const inlineBaseURL = resolveAxiosMethodBaseURL(path, resolve);
        if (inlineBaseURL) {
          urlValue = joinBaseAndPath(inlineBaseURL, urlValue);
          trace.push("Join(axiosMethodConfig.baseURL,path)");
        }
      }

      if (!method && typeof target.definition.methodArg === "number") {
        const methodResolved = resolveCallArgumentByIndex(
          path,
          target.definition.methodArg,
          resolve,
        );
        if (methodResolved) {
          method = toHttpMethod(methodResolved.value);
          trace.push(...methodResolved.trace);
        }
      }

      if (!method && target.definition.match === "fetch" && path.isCallExpression()) {
        method = resolveFetchLikeMethod(path, resolve) ?? "GET";
      }

      if (!method && target.definition.match === "Request" && path.isNewExpression()) {
        method = resolveFetchLikeMethod(path, resolve) ?? "GET";
      }

      const rendered = urlValue ? renderValue(urlValue) : null;
      if (!rendered && !includeUnresolved) {
        continue;
      }

      if (
        rendered &&
        !includeUnresolved &&
        rendered.url === null &&
        rendered.urlTemplate === null
      ) {
        continue;
      }

      const requestMetadata = extractRequestMetadata(path, target.definition, resolve);
      const snippetData = ensureSnippetContext();

      const location = path.node.loc?.start;
      const line = location?.line ?? 1;
      const column = (location?.column ?? 0) + 1;
      const finding: Finding = {
        file: normalizedFilePath,
        line,
        column,
        sink: target.definition.name,
        method,
        url: rendered?.url ?? null,
        urlTemplate: rendered?.urlTemplate ?? null,
        confidence: rendered?.confidence ?? "low",
        resolutionTrace: dedupeTrace([...trace, `Sink(${target.definition.name})`]),
        codeSnippet: buildCodeSnippet(
          snippetData.prettySource,
          snippetData.prettyLines,
          snippetData.prettyTraceMap,
          prettySourceName,
          path,
        ),
        headers: requestMetadata.headers.length > 0 ? requestMetadata.headers : undefined,
        body: requestMetadata.body,
      };

      findings.push(finding);
    }
  };

  indexes.callExpressions.forEach((callPath) => {
    try {
      processSink(callPath);
    } catch {
      // Keep analysis resilient per-file and continue.
    }
  });

  indexes.newExpressions.forEach((newPath) => {
    try {
      processSink(newPath);
    } catch {
      // Keep analysis resilient per-file and continue.
    }
  });

  return {
    findings,
    analysisMs: elapsedMs(analysisStart),
    resolverMs: resolver.metrics.resolveMs,
    resolverCalls: resolver.metrics.resolveCalls,
    resolverCacheHits: resolver.metrics.cacheHits,
  };
}

export function analyzeSource(
  source: string,
  filePath: string,
  options: AnalyzeSourceOptions = {},
): AnalyzeFileResult {
  const normalizedFilePath = normalizeFilePath(filePath);
  const parseStart = nowMs();
  const parsed = parseCode(source, filePath);
  const parseMs = elapsedMs(parseStart);
  if (!parsed.ast) {
    const timing: FileAnalysisTiming | undefined = options.profile
      ? {
          file: normalizedFilePath,
          parseMs,
          analysisMs: 0,
          resolverMs: 0,
          resolverCalls: 0,
          resolverCacheHits: 0,
          findings: 0,
        }
      : undefined;
    return {
      file: normalizedFilePath,
      findings: [],
      errors: parsed.errors,
      timing,
    };
  }

  const analysis = analyzeAst(parsed.ast, source, filePath, options);

  const timing: FileAnalysisTiming | undefined = options.profile
    ? {
        file: normalizedFilePath,
        parseMs,
        analysisMs: analysis.analysisMs,
        resolverMs: analysis.resolverMs,
        resolverCalls: analysis.resolverCalls,
        resolverCacheHits: analysis.resolverCacheHits,
        findings: analysis.findings.length,
      }
    : undefined;

  return {
    file: normalizedFilePath,
    findings: analysis.findings,
    errors: parsed.errors,
    timing,
  };
}

export async function analyzeFile(
  filePath: string,
  options: AnalyzeSourceOptions = {},
): Promise<AnalyzeFileResult> {
  const normalizedFilePath = normalizeFilePath(filePath);
  const parseStart = nowMs();
  const parsed = await parseFile(filePath);
  const parseMs = elapsedMs(parseStart);
  if (!parsed.ast) {
    const timing: FileAnalysisTiming | undefined = options.profile
      ? {
          file: normalizedFilePath,
          parseMs,
          analysisMs: 0,
          resolverMs: 0,
          resolverCalls: 0,
          resolverCacheHits: 0,
          findings: 0,
        }
      : undefined;
    return {
      file: normalizedFilePath,
      findings: [],
      errors: parsed.errors,
      timing,
    };
  }

  const analysis = analyzeAst(parsed.ast, parsed.source, filePath, options);

  const timing: FileAnalysisTiming | undefined = options.profile
    ? {
        file: normalizedFilePath,
        parseMs,
        analysisMs: analysis.analysisMs,
        resolverMs: analysis.resolverMs,
        resolverCalls: analysis.resolverCalls,
        resolverCacheHits: analysis.resolverCacheHits,
        findings: analysis.findings.length,
      }
    : undefined;

  return {
    file: normalizedFilePath,
    findings: analysis.findings,
    errors: parsed.errors,
    timing,
  };
}
