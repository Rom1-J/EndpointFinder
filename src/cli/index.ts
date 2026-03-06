#!/usr/bin/env node

import path from "node:path";
import { analyzeProject } from "../analysis/analyzeProject";
import { analyzeUrlTarget } from "../analysis/analyzeUrl";
import { toExportReport, type ExportFormat } from "../report/exportReporter";
import { toJsonReport } from "../report/jsonReporter";
import { toTextReport } from "../report/textReporter";
import { loadSinkDefinitions } from "../sinks/sinkConfig";

interface CliOptions {
  target: string | null;
  configPath?: string;
  json: boolean;
  exportFormat?: ExportFormat;
  includeUnresolved: boolean;
  siteMode?: "direct" | "clone";
  cloneDir?: string;
  maxRemoteFiles?: number;
  timeoutMs?: number;
  sameOriginOnly: boolean;
  help: boolean;
}

function isHttpUrl(target: string): boolean {
  try {
    const parsed = new URL(target);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function parseNumberArg(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function usage(): string {
  return [
    "Usage:",
    "  analyze-endpoints <path|url> [--json] [--export <swagger|postman|burp>] [--config <file>] [--unresolved]",
    "                   [--site-mode <direct|clone>] [--clone-dir <dir>]",
    "                   [--max-remote-files <n>] [--timeout-ms <n>] [--same-origin-only]",
    "",
    "Examples:",
    "  analyze-endpoints ./dist",
    "  analyze-endpoints ./chunk.js --json",
    "  analyze-endpoints ./dist --export swagger",
    "  analyze-endpoints ./dist --export postman",
    "  analyze-endpoints ./dist --export burp",
    "  analyze-endpoints ./src --config ./examples/custom-sinks.json",
    "  analyze-endpoints https://example.com --site-mode direct",
    "  analyze-endpoints https://example.com --site-mode clone --clone-dir ./site-snapshot",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    target: null,
    json: false,
    includeUnresolved: false,
    sameOriginOnly: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--export") {
      const value = argv[index + 1];
      if (!value || (value !== "swagger" && value !== "postman" && value !== "burp")) {
        throw new Error("--export requires one of: swagger, postman, burp");
      }
      options.exportFormat = value;
      index += 1;
      continue;
    }
    if (arg === "--unresolved") {
      options.includeUnresolved = true;
      continue;
    }
    if (arg === "--same-origin-only") {
      options.sameOriginOnly = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--config requires a file path");
      }
      options.configPath = value;
      index += 1;
      continue;
    }
    if (arg === "--site-mode") {
      const value = argv[index + 1];
      if (!value || (value !== "direct" && value !== "clone")) {
        throw new Error("--site-mode requires direct or clone");
      }
      options.siteMode = value;
      index += 1;
      continue;
    }
    if (arg === "--clone-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--clone-dir requires a directory path");
      }
      options.cloneDir = value;
      index += 1;
      continue;
    }
    if (arg === "--max-remote-files") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--max-remote-files requires a number");
      }
      options.maxRemoteFiles = parseNumberArg(value, "--max-remote-files");
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--timeout-ms requires a number");
      }
      options.timeoutMs = parseNumberArg(value, "--timeout-ms");
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (!options.target) {
      options.target = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || !options.target) {
      process.stdout.write(`${usage()}\n`);
      process.exit(options.help ? 0 : 1);
      return;
    }

    if (options.json && options.exportFormat) {
      throw new Error("--json and --export cannot be used together");
    }

    const sinkDefinitions = await loadSinkDefinitions(
      options.configPath ? path.resolve(options.configPath) : undefined,
    );

    const targetIsUrl = isHttpUrl(options.target) || options.siteMode !== undefined;
    const siteMode = options.siteMode ?? "direct";

    if (!targetIsUrl && siteMode === "clone") {
      throw new Error("--site-mode clone can only be used with a URL target");
    }
    if (!targetIsUrl && options.cloneDir) {
      throw new Error("--clone-dir can only be used with a URL target");
    }

    const result = targetIsUrl
      ? await analyzeUrlTarget(options.target, {
          sinkDefinitions,
          includeUnresolved: options.includeUnresolved,
          siteMode,
          cloneDir: options.cloneDir,
          maxRemoteFiles: options.maxRemoteFiles,
          timeoutMs: options.timeoutMs,
          sameOriginOnly: options.sameOriginOnly,
        })
      : await analyzeProject(options.target, {
          sinkDefinitions,
          includeUnresolved: options.includeUnresolved,
        });

    if (options.json) {
      process.stdout.write(`${toJsonReport(result)}\n`);
      return;
    }

    if (options.exportFormat) {
      process.stdout.write(`${toExportReport(result, options.exportFormat)}\n`);
      return;
    }

    process.stdout.write(`${toTextReport(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }
}

void main();
