import os from "node:os";

export function defaultConcurrency(): number {
  const cpuCount = os.cpus().length;
  return Math.max(1, Math.min(cpuCount, 8));
}

export function normalizeConcurrency(value?: number): number {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return defaultConcurrency();
  }
  return Math.max(1, Math.floor(value));
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}
