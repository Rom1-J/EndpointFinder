export function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function elapsedMs(startMs: number): number {
  return Math.max(0, nowMs() - startMs);
}

export function formatMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}
