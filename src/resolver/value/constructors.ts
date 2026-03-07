import type * as t from "@babel/types";
import type {
  ArrayValue,
  AxiosInstanceValue,
  CallableValue,
  DynamicValue,
  FunctionRefValue,
  LiteralValue,
  ObjectValue,
  ResolvedValue,
  SinkRefType,
  SinkRefValue,
  UnknownValue,
  XhrInstanceValue,
} from "./types";

export function literalValue(value: string): LiteralValue {
  return { kind: "literal", value };
}

export function dynamicValue(label = "dynamic"): DynamicValue {
  return { kind: "dynamic", label };
}

export function unknownValue(reason = "unknown"): UnknownValue {
  return { kind: "unknown", reason };
}

export function objectValue(
  properties: Record<string, ResolvedValue>,
): ObjectValue {
  return { kind: "object", properties };
}

export function arrayValue(elements: ResolvedValue[]): ArrayValue {
  return { kind: "array", elements };
}

export function functionRefValue(
  functionNode: t.Function,
  label: string,
): FunctionRefValue {
  return {
    kind: "functionRef",
    functionNode,
    label,
  };
}

export function callableValue(
  returnValue: ResolvedValue,
  label: string,
): CallableValue {
  return {
    kind: "callable",
    returnValue,
    label,
  };
}

export function sinkRefValue(definition: {
  sinkName: string;
  match: string;
  sinkType: SinkRefType;
  urlArg: number;
  methodArg?: number;
  httpMethod?: string;
  baseURL?: ResolvedValue | null;
}): SinkRefValue {
  return {
    kind: "sinkRef",
    sinkName: definition.sinkName,
    match: definition.match,
    sinkType: definition.sinkType,
    urlArg: definition.urlArg,
    methodArg: definition.methodArg,
    httpMethod: definition.httpMethod,
    baseURL: definition.baseURL,
  };
}

export function axiosInstanceValue(baseURL: ResolvedValue): AxiosInstanceValue {
  return { kind: "axiosInstance", baseURL };
}

export function xhrInstanceValue(): XhrInstanceValue {
  return { kind: "xhrInstance" };
}
