import { describe, expect, it } from "vitest";
import { collectSiteSources } from "../src/web/siteSourceCollector";

function tlsGuardedFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
      throw new Error("self signed certificate");
    }

    if (requestUrl === "https://tls.test/app.js") {
      return new Response("fetch('/api/ping')", {
        status: 200,
        headers: {
          "content-type": "application/javascript",
        },
      });
    }

    return new Response("not found", {
      status: 404,
      headers: {
        "content-type": "text/plain",
      },
    });
  }) as typeof fetch;
}

describe("ignore TLS errors option", () => {
  it("returns fetch error without ignore flag", async () => {
    const result = await collectSiteSources("https://tls.test/app.js", {
      fetchImpl: tlsGuardedFetch(),
    });

    expect(result.sources).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("Failed to fetch entry URL");
  });

  it("allows URL collection when --ignore-tls-errors is enabled", async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";

    try {
      const result = await collectSiteSources("https://tls.test/app.js", {
        fetchImpl: tlsGuardedFetch(),
        ignoreTlsErrors: true,
      });

      expect(result.errors).toEqual([]);
      expect(result.sources.map((source) => source.url)).toEqual([
        "https://tls.test/app.js",
      ]);
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1");
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
      }
    }
  });
});
