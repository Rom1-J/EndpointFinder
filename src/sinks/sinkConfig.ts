import { readFile } from "node:fs/promises";
import { builtinSinks } from "./builtinSinks";

export type SinkType = "call" | "method" | "constructor";

export interface SinkDefinition {
  name: string;
  type: SinkType;
  match: string;
  urlArg: number;
  baseURLArg?: number;
  methodArg?: number;
  httpMethod?: string;
}

export interface SinkConfigFile {
  sinks: SinkDefinition[];
}

function isSinkType(value: unknown): value is SinkType {
  return value === "call" || value === "method" || value === "constructor";
}

function normalizeDefinition(
  raw: Partial<SinkDefinition>,
  index: number,
): SinkDefinition {
  if (!raw.name || typeof raw.name !== "string") {
    throw new Error(`Invalid sink at index ${index}: missing name`);
  }
  if (!isSinkType(raw.type)) {
    throw new Error(`Invalid sink ${raw.name}: invalid type`);
  }
  if (!raw.match || typeof raw.match !== "string") {
    throw new Error(`Invalid sink ${raw.name}: missing match`);
  }
  if (typeof raw.urlArg !== "number") {
    throw new Error(`Invalid sink ${raw.name}: missing urlArg`);
  }

  return {
    name: raw.name,
    type: raw.type,
    match: raw.match,
    urlArg: raw.urlArg,
    baseURLArg: typeof raw.baseURLArg === "number" ? raw.baseURLArg : undefined,
    methodArg: typeof raw.methodArg === "number" ? raw.methodArg : undefined,
    httpMethod:
      typeof raw.httpMethod === "string"
        ? raw.httpMethod.toUpperCase()
        : undefined,
  };
}

export function mergeSinkDefinitions(
  customSinks: SinkDefinition[] = [],
): SinkDefinition[] {
  return [...builtinSinks, ...customSinks];
}

export async function loadSinkDefinitions(
  configPath?: string,
): Promise<SinkDefinition[]> {
  if (!configPath) {
    return [...builtinSinks];
  }

  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<SinkConfigFile>;
  if (!Array.isArray(parsed.sinks)) {
    throw new Error("Sink config must contain a sinks array");
  }

  const customSinks = parsed.sinks.map((sink, index) =>
    normalizeDefinition(sink, index),
  );

  return mergeSinkDefinitions(customSinks);
}
