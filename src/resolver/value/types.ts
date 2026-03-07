import type * as t from "@babel/types";

export type ResolvedValue =
  | LiteralValue
  | DynamicValue
  | UnknownValue
  | ConcatValue
  | UnionValue
  | ObjectValue
  | ArrayValue
  | FunctionRefValue
  | CallableValue
  | SinkRefValue
  | AxiosInstanceValue
  | XhrInstanceValue;

export type SinkRefType = "call" | "method" | "constructor";

export interface LiteralValue {
  kind: "literal";
  value: string;
}

export interface DynamicValue {
  kind: "dynamic";
  label: string;
}

export interface UnknownValue {
  kind: "unknown";
  reason: string;
}

export interface ConcatValue {
  kind: "concat";
  parts: ResolvedValue[];
}

export interface UnionValue {
  kind: "union";
  options: ResolvedValue[];
}

export interface ObjectValue {
  kind: "object";
  properties: Record<string, ResolvedValue>;
}

export interface ArrayValue {
  kind: "array";
  elements: ResolvedValue[];
}

export interface FunctionRefValue {
  kind: "functionRef";
  functionNode: t.Function;
  label: string;
}

export interface CallableValue {
  kind: "callable";
  returnValue: ResolvedValue;
  label: string;
}

export interface SinkRefValue {
  kind: "sinkRef";
  sinkName: string;
  match: string;
  sinkType: SinkRefType;
  urlArg: number;
  methodArg?: number;
  httpMethod?: string;
  baseURL?: ResolvedValue | null;
}

export interface AxiosInstanceValue {
  kind: "axiosInstance";
  baseURL: ResolvedValue;
}

export interface XhrInstanceValue {
  kind: "xhrInstance";
}
