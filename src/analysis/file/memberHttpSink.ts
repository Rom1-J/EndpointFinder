import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { renderValue } from "../../resolver/renderValue";
import type { ResolvedResult, ResolverContext } from "../../resolver/types";
import { getObjectProperty, type ResolvedValue } from "../../resolver/valueModel";
import type { SinkDefinition } from "../../sinks/sinkConfig";
import type { Confidence } from "../../types";
import { expressionToPath, getStaticPropertyName } from "../../utils/ast";

type ResolveFn = (path: NodePath<t.Expression>) => ResolvedResult;

const HTTP_VERBS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const PATH_PREFIXES = ["/", "./", "../", "http://", "https://", "ws://", "wss://"];
const PATH_HINTS = ["/api/", "/v1/", "/v2/", "/client/", "/users/", "/auth/"];
const OBJECT_HINTS = ["http", "api", "client", "request", "service", "rest"];
const BASE_URL_HINT = /(baseurl|apiurl|rooturl|endpoint)/i;

function resolveCallArg(
  path: NodePath<t.CallExpression>,
  index: number,
  resolve: ResolveFn,
): ResolvedResult | null {
  const argPath = path.get(`arguments.${index}`);
  if (!argPath || !argPath.isExpression()) {
    return null;
  }
  return resolve(argPath);
}

function toStrictHttpVerb(value: ResolvedValue | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value.kind === "literal") {
    const upper = value.value.toUpperCase();
    return HTTP_VERBS.has(upper) ? upper : null;
  }
  if (value.kind === "union") {
    const options = value.options
      .map((option) => toStrictHttpVerb(option))
      .filter((option): option is string => option !== null);
    if (options.length === 1) {
      return options[0];
    }
  }
  return null;
}

function looksLikePathLike(
  resolved: ResolvedResult | null,
): {
  match: boolean;
  strong: boolean;
  reason?: string;
} {
  if (!resolved) {
    return { match: false, strong: false };
  }

  const rendered = renderValue(resolved.value);
  const text = rendered.url ?? rendered.urlTemplate;
  if (!text) {
    return { match: false, strong: false };
  }

  const lowered = text.toLowerCase();
  if (PATH_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    return {
      match: true,
      strong: true,
      reason: "first argument resolved to absolute/path-like URL",
    };
  }

  if (PATH_HINTS.some((hint) => lowered.includes(hint))) {
    return {
      match: true,
      strong: true,
      reason: "first argument resolved to API-like route",
    };
  }

  if (lowered.includes("/") && !lowered.includes(" ")) {
    return {
      match: true,
      strong: false,
      reason: "first argument resolved to slash-delimited path",
    };
  }

  return {
    match: false,
    strong: false,
  };
}

function objectHintScore(objectPath: string | null): {
  score: number;
  reason: string[];
} {
  if (!objectPath) {
    return { score: 0, reason: [] };
  }

  const segments = objectPath
    .toLowerCase()
    .split(".")
    .filter((segment) => segment.length > 0);
  const matches = segments.filter((segment) =>
    OBJECT_HINTS.some((hint) => segment.includes(hint)),
  );

  if (matches.length === 0) {
    return { score: 0, reason: [] };
  }

  return {
    score: Math.min(matches.length, 2),
    reason: [`object chain contains HTTP-like segment(s): ${[...new Set(matches)].join(",")}`],
  };
}

function hasMemberAssignmentEvidence(
  objectPath: string | null,
  context: ResolverContext,
): {
  score: number;
  reason: string[];
} {
  if (!objectPath) {
    return { score: 0, reason: [] };
  }
  if (!context.memberAssignments.has(objectPath)) {
    return { score: 0, reason: [] };
  }

  return {
    score: 1,
    reason: [`member assignment seen for ${objectPath}`],
  };
}

function hasBaseUrlTraceHint(urlResult: ResolvedResult | null): {
  score: number;
  reason: string[];
} {
  if (!urlResult) {
    return { score: 0, reason: [] };
  }

  const joined = urlResult.trace.join(" ");
  if (!BASE_URL_HINT.test(joined)) {
    return { score: 0, reason: [] };
  }

  return {
    score: 1,
    reason: ["resolution trace includes base/api URL hints"],
  };
}

function scoreToConfidence(score: number): Confidence {
  if (score >= 5) {
    return "high";
  }
  if (score >= 3) {
    return "medium";
  }
  return "low";
}

function buildDetectionConfidence(params: {
  methodName: string;
  method: string | null;
  urlResult: ResolvedResult | null;
  objectPath: string | null;
  context: ResolverContext;
}): {
  confidence: Confidence;
  detectionReason: string[];
  accept: boolean;
} {
  const reasons: string[] = [];
  let score = 0;

  const pathEvidence = looksLikePathLike(params.urlResult);
  if (pathEvidence.match) {
    score += pathEvidence.strong ? 2 : 1;
    if (pathEvidence.reason) {
      reasons.push(pathEvidence.reason);
    }
  }

  const objectEvidence = objectHintScore(params.objectPath);
  score += objectEvidence.score;
  reasons.push(...objectEvidence.reason);

  const assignmentEvidence = hasMemberAssignmentEvidence(params.objectPath, params.context);
  score += assignmentEvidence.score;
  reasons.push(...assignmentEvidence.reason);

  const baseUrlEvidence = hasBaseUrlTraceHint(params.urlResult);
  score += baseUrlEvidence.score;
  reasons.push(...baseUrlEvidence.reason);

  if (params.methodName !== "request") {
    score += 1;
    reasons.push(`member method name is ${params.methodName}`);
  } else if (params.method) {
    score += 1;
    reasons.push("request(...) includes explicit HTTP method");
  }

  const accept = pathEvidence.match || objectEvidence.score > 0 || assignmentEvidence.score > 0;
  return {
    confidence: scoreToConfidence(score),
    detectionReason: reasons,
    accept,
  };
}

function createMethodSinkDefinition(
  methodName: string,
  urlArg: number,
  httpMethod?: string,
  methodArg?: number,
): SinkDefinition {
  return {
    name: `member-http.${methodName}`,
    type: "method",
    match: `member-http.${methodName}`,
    urlArg,
    methodArg,
    httpMethod,
  };
}

interface RequestSignatureResolution {
  definition: SinkDefinition;
  urlResult: ResolvedResult | null;
  method: string | null;
  trace: string[];
}

function resolveRequestSignature(
  path: NodePath<t.CallExpression>,
  resolve: ResolveFn,
): RequestSignatureResolution | null {
  const firstArg = resolveCallArg(path, 0, resolve);
  const secondArg = resolveCallArg(path, 1, resolve);

  if (!firstArg) {
    return null;
  }

  const urlFromConfig = getObjectProperty(firstArg.value, "url");
  if (urlFromConfig) {
    const methodFromConfig = toStrictHttpVerb(getObjectProperty(firstArg.value, "method"));
    return {
      definition: createMethodSinkDefinition("request", 0, methodFromConfig ?? undefined),
      urlResult: {
        value: urlFromConfig,
        trace: [...firstArg.trace, "RequestConfig.url"],
      },
      method: methodFromConfig,
      trace: ["MemberHttp.request(config)"] ,
    };
  }

  const methodFromFirst = toStrictHttpVerb(firstArg.value);
  if (methodFromFirst && secondArg) {
    return {
      definition: createMethodSinkDefinition("request", 1, undefined, 0),
      urlResult: secondArg,
      method: methodFromFirst,
      trace: ["MemberHttp.request(method,url)", ...firstArg.trace],
    };
  }

  const methodFromSecond = secondArg
    ? toStrictHttpVerb(getObjectProperty(secondArg.value, "method"))
    : null;

  return {
    definition: createMethodSinkDefinition("request", 0, methodFromSecond ?? undefined),
    urlResult: firstArg,
    method: methodFromSecond,
    trace: ["MemberHttp.request(url,options)"],
  };
}

export interface MemberHttpSinkCandidate {
  definition: SinkDefinition;
  urlResult: ResolvedResult | null;
  method: string | null;
  confidence: Confidence;
  detectionReason: string[];
  trace: string[];
}

export function detectMemberHttpSinkCandidate(
  path: NodePath<t.CallExpression>,
  resolve: ResolveFn,
  context: ResolverContext,
): MemberHttpSinkCandidate | null {
  const calleePath = path.get("callee");
  if (!calleePath.isMemberExpression()) {
    return null;
  }

  const methodName = getStaticPropertyName(calleePath.node)?.toLowerCase();
  if (!methodName) {
    return null;
  }

  const methodDefinitions: Record<string, { method: string; urlArg: number }> = {
    get: { method: "GET", urlArg: 0 },
    post: { method: "POST", urlArg: 0 },
    put: { method: "PUT", urlArg: 0 },
    patch: { method: "PATCH", urlArg: 0 },
    delete: { method: "DELETE", urlArg: 0 },
  };

  const objectPath = expressionToPath(calleePath.node.object);

  if (methodName === "request") {
    const requestResolution = resolveRequestSignature(path, resolve);
    if (!requestResolution || !requestResolution.urlResult) {
      return null;
    }

    const scored = buildDetectionConfidence({
      methodName,
      method: requestResolution.method,
      urlResult: requestResolution.urlResult,
      objectPath,
      context,
    });
    if (!scored.accept) {
      return null;
    }

    return {
      definition: requestResolution.definition,
      urlResult: requestResolution.urlResult,
      method: requestResolution.method,
      confidence: scored.confidence,
      detectionReason: scored.detectionReason,
      trace: [
        `MemberExpression(${objectPath ?? "unknown"}.request)`,
        ...requestResolution.trace,
      ],
    };
  }

  const methodDefinition = methodDefinitions[methodName];
  if (!methodDefinition) {
    return null;
  }

  const urlResult = resolveCallArg(path, methodDefinition.urlArg, resolve);
  const scored = buildDetectionConfidence({
    methodName,
    method: methodDefinition.method,
    urlResult,
    objectPath,
    context,
  });
  if (!scored.accept) {
    return null;
  }

  return {
    definition: createMethodSinkDefinition(
      methodName,
      methodDefinition.urlArg,
      methodDefinition.method,
    ),
    urlResult,
    method: methodDefinition.method,
    confidence: scored.confidence,
    detectionReason: scored.detectionReason,
    trace: [`MemberExpression(${objectPath ?? "unknown"}.${methodName})`],
  };
}
