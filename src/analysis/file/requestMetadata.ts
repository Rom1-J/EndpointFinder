import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { SinkDefinition } from "../../sinks/sinkConfig";
import type { FindingBody, FindingHeader } from "../../types";
import { resolveArg, type ResolveFn } from "./metadata/args";
import { resolveBodyFromExpression } from "./metadata/body";
import { mergeHeaders, requestMetadataFromConfig } from "./metadata/config";

export function extractRequestMetadata(
  sinkPath: NodePath<t.CallExpression> | NodePath<t.NewExpression>,
  sinkDefinition: SinkDefinition,
  resolve: ResolveFn,
): {
  headers: FindingHeader[];
  body: FindingBody | null;
} {
  let headers: FindingHeader[] = [];
  let body: FindingBody | null = null;

  const matchName = sinkDefinition.match;

  if (
    (matchName === "fetch" && sinkPath.isCallExpression()) ||
    (matchName === "Request" && sinkPath.isNewExpression())
  ) {
    const initConfig = resolveArg(sinkPath, 1, resolve);
    const fromConfig = requestMetadataFromConfig(
      initConfig?.value ?? null,
      initConfig?.path ?? null,
      sinkPath,
      resolve,
    );
    headers = mergeHeaders(headers, fromConfig.headers);
    body = body ?? fromConfig.body;
  } else if (matchName === "navigator.sendBeacon" && sinkPath.isCallExpression()) {
    const bodyArg = resolveArg(sinkPath, 1, resolve);
    if (bodyArg) {
      body = resolveBodyFromExpression(bodyArg.path, sinkPath, resolve);
    }
  } else if (matchName === "axios" && sinkPath.isCallExpression()) {
    const firstArg = resolveArg(sinkPath, 0, resolve);
    const secondArg = resolveArg(sinkPath, 1, resolve);

    const firstConfig = requestMetadataFromConfig(
      firstArg?.value ?? null,
      firstArg?.path ?? null,
      sinkPath,
      resolve,
    );
    const secondConfig = requestMetadataFromConfig(
      secondArg?.value ?? null,
      secondArg?.path ?? null,
      sinkPath,
      resolve,
    );

    headers = mergeHeaders(firstConfig.headers, secondConfig.headers);
    body = firstConfig.body ?? secondConfig.body;
  } else if (matchName.startsWith("axios.") && sinkPath.isCallExpression()) {
    const method = matchName.split(".")[1] ?? "";
    const configIndex = ["post", "put", "patch"].includes(method) ? 2 : 1;
    const configArg = resolveArg(sinkPath, configIndex, resolve);
    const configMetadata = requestMetadataFromConfig(
      configArg?.value ?? null,
      configArg?.path ?? null,
      sinkPath,
      resolve,
    );
    headers = mergeHeaders(headers, configMetadata.headers);

    if (["post", "put", "patch"].includes(method)) {
      const bodyArg = resolveArg(sinkPath, 1, resolve);
      if (bodyArg) {
        body = resolveBodyFromExpression(bodyArg.path, sinkPath, resolve);
      }
    }

    body = body ?? configMetadata.body;
  }

  if (headers.length === 0 && body === null && sinkPath.isCallExpression()) {
    const fallbackConfig = resolveArg(
      sinkPath,
      sinkDefinition.urlArg + 1,
      resolve,
    );
    const fallbackMetadata = requestMetadataFromConfig(
      fallbackConfig?.value ?? null,
      fallbackConfig?.path ?? null,
      sinkPath,
      resolve,
    );
    headers = mergeHeaders(headers, fallbackMetadata.headers);
    body = body ?? fallbackMetadata.body;
  }

  return {
    headers,
    body,
  };
}
