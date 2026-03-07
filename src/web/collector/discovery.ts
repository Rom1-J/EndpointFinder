import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { parse as parseHtml } from "node-html-parser";
import { parseCode } from "../../parser/parseFile";
import {
  isLikelyResolvedChunk,
  resolveChunkLikeSpecifier,
  resolveSpecifier,
  shouldAddDiscoveredSpecifier,
} from "./urlUtils";

export function extractScriptUrlsFromHtml(
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

export function discoverScriptUrlsFromJavaScript(
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

    if (!shouldAddDiscoveredSpecifier(trimmed, fromImportLikeContext)) {
      return;
    }

    const resolved = fromImportLikeContext
      ? resolveSpecifier(sourceUrl, trimmed)
      : resolveChunkLikeSpecifier(sourceUrl, trimmed);
    if (!resolved) {
      return;
    }

    if (!isLikelyResolvedChunk(resolved) && !fromImportLikeContext) {
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
