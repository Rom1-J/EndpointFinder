import { readFile } from "node:fs/promises";
import { parse } from "@babel/parser";
import type { ParserPlugin } from "@babel/parser";
import type { File } from "@babel/types";

export interface ParseSuccess {
  ast: File;
  source: string;
  errors: string[];
}

export interface ParseFailure {
  ast: null;
  source: string;
  errors: string[];
}

export type ParseResult = ParseSuccess | ParseFailure;

const PARSER_PLUGINS: ParserPlugin[] = [
  "typescript",
  "jsx",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "dynamicImport",
  "optionalChaining",
  "nullishCoalescingOperator",
  "objectRestSpread",
  "topLevelAwait",
  "decorators-legacy",
];

export function parseCode(source: string, filePath: string): ParseResult {
  try {
    const ast = parse(source, {
      sourceType: "unambiguous",
      sourceFilename: filePath,
      plugins: PARSER_PLUGINS,
      errorRecovery: true,
      allowReturnOutsideFunction: true,
    });

    const parserErrors = ast.errors?.map((error) => error.message) ?? [];

    return {
      ast,
      source,
      errors: parserErrors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ast: null,
      source,
      errors: [message],
    };
  }
}

export async function parseFile(filePath: string): Promise<ParseResult> {
  try {
    const source = await readFile(filePath, "utf8");
    return parseCode(source, filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ast: null,
      source: "",
      errors: [message],
    };
  }
}
