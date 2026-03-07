export const DEFAULT_MAX_REMOTE_FILES = 200;
export const DEFAULT_TIMEOUT_MS = 15000;

function isHttpUrl(target: string): boolean {
  try {
    const parsed = new URL(target);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeHttpUrl(target: string): string {
  let normalized = target.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }
  if (!isHttpUrl(normalized)) {
    throw new Error(`Invalid HTTP(S) URL: ${target}`);
  }
  return new URL(normalized).toString();
}

export function isJavaScriptContentType(contentType: string | null): boolean {
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

export function isLikelyJavaScriptUrl(resourceUrl: string): boolean {
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

export function shouldTreatAsJavaScript(
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
  if (/((\.css|\.png|\.jpg|\.jpeg|\.svg|\.gif|\.webp|\.ico|\.woff|\.woff2|\.ttf|\.map)(\?|#|$))/.test(lowered)) {
    return false;
  }
  return /\.m?js(\?|#|$)/.test(lowered);
}

export function resolveSpecifier(baseUrl: string, specifier: string): string | null {
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

export function resolveChunkLikeSpecifier(baseUrl: string, specifier: string): string | null {
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

export function shouldAddDiscoveredSpecifier(
  value: string,
  fromImportLikeContext: boolean,
): boolean {
  if (fromImportLikeContext) {
    return isImportLikeSpecifier(value);
  }
  return isLikelyChunkSpecifier(value);
}

export function isLikelyResolvedChunk(resolved: string): boolean {
  return isLikelyChunkSpecifier(resolved);
}
