import type { AnalyzeProjectResult } from "../types";
import { formatMs } from "../utils/perf";

function percent(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0.0%";
  }
  return `${value.toFixed(1)}%`;
}

export function toProfileReport(result: AnalyzeProjectResult): string {
  const timings = result.timings;
  if (!timings) {
    return "Profiling is not enabled for this run.";
  }

  const totalResolverCalls = timings.fileTimings.reduce(
    (sum, timing) => sum + timing.resolverCalls,
    0,
  );
  const totalResolverHits = timings.fileTimings.reduce(
    (sum, timing) => sum + timing.resolverCacheHits,
    0,
  );
  const cacheHitRate =
    totalResolverCalls > 0 ? (totalResolverHits / totalResolverCalls) * 100 : 0;

  const slowestFiles = [...timings.fileTimings]
    .sort((left, right) => {
      const leftTotal = left.parseMs + left.analysisMs;
      const rightTotal = right.parseMs + right.analysisMs;
      return rightTotal - leftTotal;
    })
    .slice(0, 10);

  const lines: string[] = [];
  lines.push("Profile Timings");
  lines.push(`- Total: ${formatMs(timings.totalMs)}`);
  lines.push(
    `- Parse: ${formatMs(timings.parseMs)} | Analysis: ${formatMs(timings.analysisMs)} | Resolver: ${formatMs(timings.resolverMs)}`,
  );
  lines.push(
    `- Resolver cache hit rate: ${percent(cacheHitRate)} (${totalResolverHits}/${totalResolverCalls})`,
  );

  if (typeof timings.webpackRegistryMs === "number") {
    lines.push(`- Webpack registry: ${formatMs(timings.webpackRegistryMs)}`);
  }
  if (typeof timings.sourceCollectionMs === "number") {
    lines.push(`- Source collection: ${formatMs(timings.sourceCollectionMs)}`);
  }
  if (typeof timings.cloneMs === "number") {
    lines.push(`- Clone write: ${formatMs(timings.cloneMs)}`);
  }
  if (typeof timings.reportMs === "number") {
    lines.push(`- Report format: ${formatMs(timings.reportMs)}`);
  }

  lines.push(`- Files timed: ${timings.fileCount}`);

  if (slowestFiles.length > 0) {
    lines.push("");
    lines.push("Slowest Files");
    slowestFiles.forEach((fileTiming, index) => {
      const totalFileMs = fileTiming.parseMs + fileTiming.analysisMs;
      lines.push(
        `${String(index + 1).padStart(2, "0")}. ${fileTiming.file} | total ${formatMs(
          totalFileMs,
        )} | parse ${formatMs(fileTiming.parseMs)} | analysis ${formatMs(
          fileTiming.analysisMs,
        )} | resolver ${formatMs(fileTiming.resolverMs)} | cache ${fileTiming.resolverCacheHits}/${fileTiming.resolverCalls}`,
      );
    });
  }

  return lines.join("\n");
}
