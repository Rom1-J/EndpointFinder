import type { AnalysisError } from "../../types";
import { mapWithConcurrency, normalizeConcurrency } from "../../utils/concurrency";
import { discoverScriptUrlsFromJavaScript, extractScriptUrlsFromHtml } from "./discovery";
import { fetchTextResource } from "./fetchResource";
import type { CollectedSiteSources, CollectSiteSourcesOptions } from "./types";
import {
  DEFAULT_MAX_REMOTE_FILES,
  DEFAULT_TIMEOUT_MS,
  normalizeHttpUrl,
  shouldTreatAsJavaScript,
} from "./urlUtils";

export async function collectSiteSources(
  targetUrl: string,
  options: CollectSiteSourcesOptions = {},
): Promise<CollectedSiteSources> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("Fetch API is not available in this runtime");
  }

  const maxRemoteFiles = options.maxRemoteFiles ?? DEFAULT_MAX_REMOTE_FILES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchConcurrency = normalizeConcurrency(options.concurrency);

  const normalizedTarget = normalizeHttpUrl(targetUrl);
  const errors: AnalysisError[] = [];

  let entryResponse:
    | {
        url: string;
        contentType: string | null;
        body: string;
      }
    | undefined;

  try {
    entryResponse = await fetchTextResource(normalizedTarget, {
      fetchImpl,
      timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      entryUrl: normalizedTarget,
      entryHtml: "",
      sources: [],
      errors: [
        {
          file: normalizedTarget,
          message: `Failed to fetch entry URL: ${message}`,
        },
      ],
    };
  }

  const entryUrl = entryResponse.url;
  const entryOrigin = new URL(entryUrl).origin;
  const queue: string[] = [];
  const queued = new Set<string>();
  const fetched = new Set<string>();
  const sources: CollectedSiteSources["sources"] = [];
  let entryHtml = "";

  const enqueue = (resourceUrl: string) => {
    let normalized = resourceUrl;
    try {
      const parsed = new URL(resourceUrl);
      if (options.sameOriginOnly && parsed.origin !== entryOrigin) {
        return;
      }
      normalized = parsed.toString();
    } catch {
      return;
    }

    if (queued.has(normalized) || fetched.has(normalized)) {
      return;
    }
    queued.add(normalized);
    queue.push(normalized);
  };

  if (shouldTreatAsJavaScript(entryUrl, entryResponse.contentType)) {
    enqueue(entryUrl);
  } else {
    entryHtml = entryResponse.body;
    const extracted = extractScriptUrlsFromHtml(entryHtml, entryUrl);
    extracted.scriptUrls.forEach(enqueue);
    extracted.inlineScripts.forEach((script, index) => {
      sources.push({
        url: `${entryUrl}#inline-script-${index + 1}`,
        content: script,
        contentType: "text/javascript",
      });
    });
  }

  const prefetched = new Map<string, typeof entryResponse>();
  prefetched.set(entryUrl, entryResponse);

  interface FetchBatchResult {
    currentUrl: string;
    response: typeof entryResponse | null;
    errorMessage: string | null;
  }

  while (queue.length > 0 && fetched.size < maxRemoteFiles) {
    const batch: string[] = [];
    while (
      queue.length > 0 &&
      batch.length < fetchConcurrency &&
      fetched.size + batch.length < maxRemoteFiles
    ) {
      const currentUrl = queue.shift();
      if (!currentUrl) {
        continue;
      }
      if (fetched.has(currentUrl)) {
        continue;
      }
      fetched.add(currentUrl);
      batch.push(currentUrl);
    }

    if (batch.length === 0) {
      break;
    }

    const batchResults = await mapWithConcurrency(
      batch,
      fetchConcurrency,
      async (currentUrl): Promise<FetchBatchResult> => {
        try {
          const maybePrefetched = prefetched.get(currentUrl);
          if (maybePrefetched) {
            prefetched.delete(currentUrl);
          }
          const response =
            maybePrefetched ??
            (await fetchTextResource(currentUrl, {
              fetchImpl,
              timeoutMs,
            }));
          return {
            currentUrl,
            response,
            errorMessage: null,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            currentUrl,
            response: null,
            errorMessage: message,
          };
        }
      },
    );

    for (const batchResult of batchResults) {
      if (batchResult.errorMessage) {
        errors.push({
          file: batchResult.currentUrl,
          message: `Failed to fetch source: ${batchResult.errorMessage}`,
        });
        continue;
      }

      const response = batchResult.response;
      if (!response) {
        continue;
      }

      if (!shouldTreatAsJavaScript(response.url, response.contentType)) {
        continue;
      }

      sources.push({
        url: response.url,
        content: response.body,
        contentType: response.contentType,
      });

      const discovered = discoverScriptUrlsFromJavaScript(response.body, response.url);
      discovered.parseErrors.forEach((message) => {
        errors.push({
          file: response.url,
          message: `Script-discovery parse warning: ${message}`,
        });
      });
      discovered.urls.forEach(enqueue);
    }
  }

  if (queue.length > 0) {
    errors.push({
      file: entryUrl,
      message: `Remote file limit reached (${maxRemoteFiles}). Some sources were not fetched.`,
    });
  }

  return {
    entryUrl,
    entryHtml,
    sources,
    errors,
  };
}
