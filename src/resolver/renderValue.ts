import type { Confidence } from "../types";
import type { ResolvedValue } from "./valueModel";

interface RenderIntermediate {
  text: string;
  exact: boolean;
  renderable: boolean;
  hasDynamic: boolean;
  hasUnknown: boolean;
}

export interface RenderedValue {
  url: string | null;
  urlTemplate: string | null;
  confidence: Confidence;
  hasDynamic: boolean;
  hasUnknown: boolean;
}

function render(value: ResolvedValue): RenderIntermediate {
  switch (value.kind) {
    case "literal":
      return {
        text: value.value,
        exact: true,
        renderable: true,
        hasDynamic: false,
        hasUnknown: false,
      };
    case "dynamic":
      return {
        text: `\${${value.label}}`,
        exact: false,
        renderable: true,
        hasDynamic: true,
        hasUnknown: false,
      };
    case "unknown":
      return {
        text: `\${${value.reason}}`,
        exact: false,
        renderable: true,
        hasDynamic: false,
        hasUnknown: true,
      };
    case "concat": {
      const parts = value.parts.map(render);
      const allRenderable = parts.every((part) => part.renderable);
      if (!allRenderable) {
        return {
          text: "",
          exact: false,
          renderable: false,
          hasDynamic: false,
          hasUnknown: true,
        };
      }
      return {
        text: parts.map((part) => part.text).join(""),
        exact: parts.every((part) => part.exact),
        renderable: true,
        hasDynamic: parts.some((part) => part.hasDynamic),
        hasUnknown: parts.some((part) => part.hasUnknown),
      };
    }
    case "union": {
      const options = value.options.map(render).filter((result) => result.renderable);
      if (options.length === 0) {
        return {
          text: "",
          exact: false,
          renderable: false,
          hasDynamic: false,
          hasUnknown: true,
        };
      }
      const uniqueTexts = [...new Set(options.map((option) => option.text))];
      if (uniqueTexts.length === 1) {
        return {
          text: uniqueTexts[0],
          exact: options.every((option) => option.exact),
          renderable: true,
          hasDynamic: options.some((option) => option.hasDynamic),
          hasUnknown: options.some((option) => option.hasUnknown),
        };
      }
      return {
        text: `(${uniqueTexts.join(" | ")})`,
        exact: false,
        renderable: true,
        hasDynamic: true,
        hasUnknown: options.some((option) => option.hasUnknown),
      };
    }
    case "object":
    case "array":
    case "functionRef":
    case "callable":
    case "axiosInstance":
    case "xhrInstance":
      return {
        text: "",
        exact: false,
        renderable: false,
        hasDynamic: false,
        hasUnknown: true,
      };
    default:
      return {
        text: "",
        exact: false,
        renderable: false,
        hasDynamic: false,
        hasUnknown: true,
      };
  }
}

function scoreConfidence(intermediate: RenderIntermediate): Confidence {
  if (intermediate.exact && intermediate.renderable) {
    return "high";
  }
  if (intermediate.renderable && !intermediate.hasUnknown) {
    return "medium";
  }
  return "low";
}

export function renderValue(value: ResolvedValue): RenderedValue {
  const intermediate = render(value);
  if (!intermediate.renderable) {
    return {
      url: null,
      urlTemplate: null,
      confidence: "low",
      hasDynamic: intermediate.hasDynamic,
      hasUnknown: true,
    };
  }

  if (intermediate.exact) {
    return {
      url: intermediate.text,
      urlTemplate: null,
      confidence: scoreConfidence(intermediate),
      hasDynamic: intermediate.hasDynamic,
      hasUnknown: intermediate.hasUnknown,
    };
  }

  return {
    url: null,
    urlTemplate: intermediate.text,
    confidence: scoreConfidence(intermediate),
    hasDynamic: intermediate.hasDynamic,
    hasUnknown: intermediate.hasUnknown,
  };
}
