import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeFilePath } from "../../utils/ast";
import type { ClonedSiteSources, CollectedSiteSources } from "./types";

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
