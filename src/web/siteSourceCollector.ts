import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { parse as parseHtml } from "node-html-parser";
import { parseCode } from "../parser/parseFile";
import type { AnalysisError } from "../types";
import { normalizeFilePath } from "../utils/ast";

export interface RemoteSourceFile {
  url: string;
  content: string;
  contentType: string | null;
}

export interface CollectedSiteSources {
  entryUrl: string;
  entryHtml: string;
  sources: RemoteSourceFile[];
  errors: AnalysisError[];
}

export interface ClonedSiteSources {
  rootDir: string;
  manifestFile: string;
  entryHtmlFile: string | null;
  sourceFiles: Array<{
    url: string;
    filePath: string;
  }>;
}

export interface CollectSiteSourcesOptions {
  fetchImpl?: typeof fetch;
  maxRemoteFiles?: number;
  timeoutMs?: number;
  sameOriginOnly?: boolean;
}

const DEFAULT_MAX_REMOTE_FILES = 200;
const DEFAULT_TIMEOUT_MS = 15000;

function isHttpUrl(target: string): boolean {
  try {
    const parsed = new URL(target);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHttpUrl(target: string): string {
  let normalized = target.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }
  if (!isHttpUrl(normalized)) {
    throw new Error(`Invalid HTTP(S) URL: ${target}`);
  }
  return new URL(normalized).toString();
}

function isJavaScriptContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  const lowered = contentType.toLowerCase();
  return (
    lowered.includes("javascript") ||
    lowered.includes("ecmascript") ||
    lowered.includes("application/x-javascript")
  );
}

function isLikelyJavaScriptUrl(resourceUrl: string): boolean {
  try {
    const parsed = new URL(resourceUrl);
    const pathname = parsed.pathname.toLowerCase();
    return (
      pathname.endsWith(".js") ||
      pathname.endsWith(".mjs") ||
      pathname.endsWith(".cjs")
    );
  } catch {
    return false;
  }
}

function shouldTreatAsJavaScript(
  resourceUrl: string,
  contentType: string | null,
): boolean {
  return isJavaScriptContentType(contentType) || isLikelyJavaScriptUrl(resourceUrl);
}

function isImportLikeSpecifier(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("//")
  );
}

function isLikelyChunkSpecifier(value: string): boolean {
  const lowered = value.toLowerCase();
  if (lowered.length === 0 || lowered.length > 300) {
    return false;
  }
  if (lowered.startsWith("data:") || lowered.startsWith("javascript:")) {
    return false;
  }
  if (/(\.css|\.png|\.jpg|\.jpeg|\.svg|\.gif|\.webp|\.ico|\.woff|\.woff2|\.ttf|\.map)(\?|#|$)/.test(lowered)) {
    return false;
  }
  return /\.m?js(\?|#|$)/.test(lowered);
}

function resolveSpecifier(baseUrl: string, specifier: string): string | null {
  try {
    const resolved = new URL(specifier, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

function countTokenOccurrences(value: string, token: string): number {
  if (token.length === 0) {
    return 0;
  }
  return value.split(token).length - 1;
}

function resolveChunkLikeSpecifier(baseUrl: string, specifier: string): string | null {
  const direct = resolveSpecifier(baseUrl, specifier);
  if (!direct) {
    return null;
  }

  try {
    const base = new URL(baseUrl);
    const directUrl = new URL(direct);

    const firstSegment = specifier.split("/").find((segment) => segment.length > 0);
    if (!firstSegment) {
      return direct;
    }

    const marker = `/${firstSegment}/`;
    const directOccurrences = countTokenOccurrences(directUrl.pathname, marker);
    const baseMarkerIndex = base.pathname.indexOf(marker);

    const resolveFromBasePrefix = (): string | null => {
      if (baseMarkerIndex < 0) {
        return null;
      }

      const basePrefixPath = base.pathname.slice(0, baseMarkerIndex + 1);
      const anchor = new URL(base.origin);
      anchor.pathname = basePrefixPath.endsWith("/")
        ? basePrefixPath
        : `${basePrefixPath}/`;
      return resolveSpecifier(anchor.toString(), specifier);
    };

    if (directOccurrences >= 2) {
      const deduped = resolveFromBasePrefix();
      if (deduped) {
        return deduped;
      }
    }

    if (specifier.startsWith("static/") && base.pathname.includes("/_next/")) {
      const nextPrefixIndex = base.pathname.indexOf("/_next/");
      const nextPrefixPath = base.pathname.slice(0, nextPrefixIndex + "/_next/".length);
      const nextAnchor = new URL(base.origin);
      nextAnchor.pathname = nextPrefixPath;
      const nextResolved = resolveSpecifier(nextAnchor.toString(), specifier);
      if (nextResolved) {
        return nextResolved;
      }
    }

    if (specifier.startsWith("_next/")) {
      const rootResolved = resolveSpecifier(`${base.origin}/`, specifier);
      if (rootResolved) {
        return rootResolved;
      }
    }
  } catch {
    return direct;
  }

  return direct;
}

function extractScriptUrlsFromHtml(
  html: string,
  baseUrl: string,
): { scriptUrls: string[]; inlineScripts: string[] } {
  const root = parseHtml(html);

  const scriptUrls = new Set<string>();
  const inlineScripts: string[] = [];

  for (const script of root.querySelectorAll("script")) {
    const src = script.getAttribute("src");
    if (src) {
      const resolved = resolveSpecifier(baseUrl, src);
      if (resolved) {
        scriptUrls.add(resolved);
      }
      continue;
    }

    const inlineCode = script.text;
    if (inlineCode && inlineCode.trim().length > 0) {
      inlineScripts.push(inlineCode);
    }
  }

  for (const link of root.querySelectorAll("link")) {
    const rel = link.getAttribute("rel")?.toLowerCase() ?? "";
    const asValue = link.getAttribute("as")?.toLowerCase() ?? "";
    if (!(rel === "modulepreload" || (rel === "preload" && asValue === "script"))) {
      continue;
    }
    const href = link.getAttribute("href");
    if (!href) {
      continue;
    }
    const resolved = resolveSpecifier(baseUrl, href);
    if (resolved) {
      scriptUrls.add(resolved);
    }
  }

  return {
    scriptUrls: [...scriptUrls],
    inlineScripts,
  };
}

function discoverScriptUrlsFromJavaScript(
  source: string,
  sourceUrl: string,
): { urls: string[]; parseErrors: string[] } {
  const parsed = parseCode(source, sourceUrl);
  if (!parsed.ast) {
    return {
      urls: [],
      parseErrors: parsed.errors,
    };
  }

  const discovered = new Set<string>();

  const addSpecifier = (specifier: string, fromImportLikeContext: boolean) => {
    const trimmed = specifier.trim();
    if (!trimmed) {
      return;
    }

    if (fromImportLikeContext && !isImportLikeSpecifier(trimmed)) {
      return;
    }

    if (!fromImportLikeContext && !isLikelyChunkSpecifier(trimmed)) {
      return;
    }

    const resolved = fromImportLikeContext
      ? resolveSpecifier(sourceUrl, trimmed)
      : resolveChunkLikeSpecifier(sourceUrl, trimmed);
    if (!resolved) {
      return;
    }

    if (!isLikelyChunkSpecifier(resolved) && !fromImportLikeContext) {
      return;
    }

    discovered.add(resolved);
  };

  traverse(parsed.ast, {
    ImportDeclaration(path) {
      addSpecifier(path.node.source.value, true);
    },
    ExportAllDeclaration(path) {
      if (path.node.source) {
        addSpecifier(path.node.source.value, true);
      }
    },
    ExportNamedDeclaration(path) {
      if (path.node.source) {
        addSpecifier(path.node.source.value, true);
      }
    },
    CallExpression(path) {
      const calleePath = path.get("callee");
      if (!calleePath.isImport()) {
        return;
      }
      const args = path.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
      const firstArg = args[0];
      if (!firstArg) {
        return;
      }
      if (firstArg.isStringLiteral()) {
        addSpecifier(firstArg.node.value, true);
        return;
      }
      if (
        firstArg.isTemplateLiteral() &&
        firstArg.node.expressions.length === 0 &&
        firstArg.node.quasis.length > 0
      ) {
        addSpecifier(firstArg.node.quasis[0].value.cooked ?? "", true);
      }
    },
    NewExpression(path) {
      const calleePath = path.get("callee");
      if (!calleePath.isIdentifier({ name: "URL" })) {
        return;
      }
      const args = path.get("arguments") as NodePath<t.Expression | t.SpreadElement>[];
      const firstArg = args[0];
      if (!firstArg) {
        return;
      }
      if (firstArg.isStringLiteral()) {
        addSpecifier(firstArg.node.value, true);
      }
    },
    StringLiteral(path) {
      addSpecifier(path.node.value, false);
    },
  });

  return {
    urls: [...discovered],
    parseErrors: parsed.errors,
  };
}

async function fetchTextResource(
  resourceUrl: string,
  options: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
  },
): Promise<{
  url: string;
  contentType: string | null;
  body: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await options.fetchImpl(resourceUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "EndpointFinder/0.1",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = await response.text();
    return {
      url: response.url || resourceUrl,
      contentType: response.headers.get("content-type"),
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
}

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
  const sources: RemoteSourceFile[] = [];
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

  while (queue.length > 0 && fetched.size < maxRemoteFiles) {
    const currentUrl = queue.shift();
    if (!currentUrl) {
      break;
    }
    if (fetched.has(currentUrl)) {
      continue;
    }
    fetched.add(currentUrl);

    let response: typeof entryResponse;
    try {
      const maybePrefetched = prefetched.get(currentUrl);
      response =
        maybePrefetched ??
        (await fetchTextResource(currentUrl, {
          fetchImpl,
          timeoutMs,
        }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({
        file: currentUrl,
        message: `Failed to fetch source: ${message}`,
      });
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

function sanitizeSegment(segment: string): string {
  const value = segment.replace(/[^A-Za-z0-9._-]/g, "_");
  return value.length > 0 ? value : "_";
}

function urlToRelativePath(resourceUrl: string, defaultExtension: string): string {
  const parsed = new URL(resourceUrl);
  const hostSegment = sanitizeSegment(parsed.host || "site");

  const rawParts = parsed.pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map(sanitizeSegment);

  let fileName = rawParts.pop() ?? `index${defaultExtension}`;

  let extension = path.extname(fileName);
  if (!extension) {
    extension = defaultExtension;
    fileName = `${fileName}${extension}`;
  }

  const stem = fileName.slice(0, fileName.length - extension.length);
  const querySuffix = parsed.search
    ? `__q_${sanitizeSegment(parsed.search.slice(1)).slice(0, 64)}`
    : "";
  const hashSuffix = parsed.hash
    ? `__h_${sanitizeSegment(parsed.hash.slice(1)).slice(0, 64)}`
    : "";
  const finalFileName = `${stem}${querySuffix}${hashSuffix}${extension}`;

  return path.join(hostSegment, ...rawParts, finalFileName);
}

export async function cloneSiteSources(
  collected: CollectedSiteSources,
  outputDir: string,
): Promise<ClonedSiteSources> {
  const rootDir = path.resolve(outputDir);
  await mkdir(rootDir, { recursive: true });

  let entryHtmlFile: string | null = null;
  if (collected.entryHtml.length > 0) {
    const entryRelativePath = path.join(
      "html",
      urlToRelativePath(collected.entryUrl, ".html"),
    );
    const entryAbsolutePath = path.join(rootDir, entryRelativePath);
    await mkdir(path.dirname(entryAbsolutePath), { recursive: true });
    await writeFile(entryAbsolutePath, collected.entryHtml, "utf8");
    entryHtmlFile = normalizeFilePath(entryAbsolutePath);
  }

  const sourceFiles: ClonedSiteSources["sourceFiles"] = [];
  for (const source of collected.sources) {
    const relativePath = path.join("sources", urlToRelativePath(source.url, ".js"));
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, source.content, "utf8");
    sourceFiles.push({
      url: source.url,
      filePath: normalizeFilePath(absolutePath),
    });
  }

  const manifestPath = path.join(rootDir, "clone-manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        entryUrl: collected.entryUrl,
        entryHtmlFile,
        sources: sourceFiles,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    rootDir: normalizeFilePath(rootDir),
    manifestFile: normalizeFilePath(manifestPath),
    entryHtmlFile,
    sourceFiles,
  };
}
