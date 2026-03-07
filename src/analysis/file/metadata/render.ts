import { getObjectProperty, type ResolvedValue } from "../../../resolver/valueModel";
import type { Finding, FindingHeader } from "../../../types";

interface GenericRenderResult {
  text: string;
  hasUnknown: boolean;
  hasDynamic: boolean;
}

function confidenceFromGeneric(rendered: GenericRenderResult): Finding["confidence"] {
  if (!rendered.hasUnknown && !rendered.hasDynamic) {
    return "high";
  }
  if (!rendered.hasUnknown) {
    return "medium";
  }
  return "low";
}

function renderGenericValue(
  value: ResolvedValue,
  mode: "inline" | "json" = "inline",
): GenericRenderResult {
  switch (value.kind) {
    case "literal":
      return {
        text: mode === "json" ? JSON.stringify(value.value) : value.value,
        hasUnknown: false,
        hasDynamic: false,
      };
    case "dynamic":
      return {
        text: `\${${value.label}}`,
        hasUnknown: false,
        hasDynamic: true,
      };
    case "unknown":
      return {
        text: `\${${value.reason}}`,
        hasUnknown: true,
        hasDynamic: false,
      };
    case "concat": {
      const parts = value.parts.map((part) => renderGenericValue(part, "inline"));
      return {
        text: parts.map((part) => part.text).join(""),
        hasUnknown: parts.some((part) => part.hasUnknown),
        hasDynamic: parts.some((part) => part.hasDynamic),
      };
    }
    case "union": {
      const options = value.options.map((option) => renderGenericValue(option, mode));
      const uniqueTexts = [...new Set(options.map((option) => option.text))];
      return {
        text: uniqueTexts.length === 1 ? uniqueTexts[0] : `(${uniqueTexts.join(" | ")})`,
        hasUnknown: options.some((option) => option.hasUnknown),
        hasDynamic: true,
      };
    }
    case "object": {
      const keys = Object.keys(value.properties).sort();
      const renderedEntries = keys.map((key) => ({
        key,
        value: renderGenericValue(value.properties[key], mode === "json" ? "json" : "inline"),
      }));
      const entryText = renderedEntries
        .map((entry) => {
          const renderedKey = mode === "json" ? JSON.stringify(entry.key) : entry.key;
          return `${renderedKey}: ${entry.value.text}`;
        })
        .join(", ");
      return {
        text: `{ ${entryText} }`,
        hasUnknown: renderedEntries.some((entry) => entry.value.hasUnknown),
        hasDynamic: renderedEntries.some((entry) => entry.value.hasDynamic),
      };
    }
    case "array": {
      const renderedElements = value.elements.map((element) =>
        renderGenericValue(element, mode === "json" ? "json" : "inline"),
      );
      return {
        text: `[${renderedElements.map((entry) => entry.text).join(", ")}]`,
        hasUnknown: renderedElements.some((entry) => entry.hasUnknown),
        hasDynamic: renderedElements.some((entry) => entry.hasDynamic),
      };
    }
    case "functionRef":
      return {
        text: "${function}",
        hasUnknown: true,
        hasDynamic: false,
      };
    case "callable":
      return renderGenericValue(value.returnValue, mode);
    case "sinkRef":
      return {
        text: `${value.match}()`,
        hasUnknown: false,
        hasDynamic: true,
      };
    case "axiosInstance":
      return {
        text: "${axiosInstance}",
        hasUnknown: true,
        hasDynamic: false,
      };
    case "xhrInstance":
      return {
        text: "${xhrInstance}",
        hasUnknown: true,
        hasDynamic: false,
      };
    default:
      return {
        text: "${unknown}",
        hasUnknown: true,
        hasDynamic: false,
      };
  }
}

function metadataFromGeneric(rendered: GenericRenderResult): {
  value: string | null;
  valueTemplate: string | null;
  confidence: Finding["confidence"];
} {
  const confidence = confidenceFromGeneric(rendered);
  if (confidence === "high") {
    return {
      value: rendered.text,
      valueTemplate: null,
      confidence,
    };
  }
  return {
    value: null,
    valueTemplate: rendered.text,
    confidence,
  };
}

export function renderMetadataValueDetailed(
  value: ResolvedValue,
  mode: "inline" | "json" = "inline",
): {
  value: string | null;
  valueTemplate: string | null;
  confidence: Finding["confidence"];
} {
  const generic = renderGenericValue(value, mode);
  return metadataFromGeneric(generic);
}

function collectObjectKeys(value: ResolvedValue, output: Set<string>): void {
  if (value.kind === "object") {
    Object.keys(value.properties).forEach((key) => output.add(key));
    return;
  }
  if (value.kind === "union") {
    value.options.forEach((option) => collectObjectKeys(option, output));
  }
}

export function extractHeadersFromValue(value: ResolvedValue): FindingHeader[] {
  const headers: FindingHeader[] = [];

  if (value.kind === "array") {
    for (const element of value.elements) {
      if (element.kind !== "array" || element.elements.length < 2) {
        continue;
      }
      const nameValue = element.elements[0];
      if (nameValue.kind !== "literal") {
        continue;
      }
      const rendered = renderMetadataValueDetailed(element.elements[1], "inline");
      headers.push({
        name: nameValue.value,
        value: rendered.value,
        valueTemplate: rendered.valueTemplate,
        confidence: rendered.confidence,
      });
    }
    return headers;
  }

  const keys = new Set<string>();
  collectObjectKeys(value, keys);
  for (const key of [...keys].sort()) {
    const headerValue = getObjectProperty(value, key);
    if (!headerValue) {
      continue;
    }
    const rendered = renderMetadataValueDetailed(headerValue, "inline");
    headers.push({
      name: key,
      value: rendered.value,
      valueTemplate: rendered.valueTemplate,
      confidence: rendered.confidence,
    });
  }

  return headers;
}
