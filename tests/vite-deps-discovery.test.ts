import { describe, expect, it } from "vitest";
import { discoverScriptUrlsFromJavaScript } from "../src/web/collector/discovery";
import { collectSiteSources } from "../src/web/siteSourceCollector";

type MockResource = {
  status?: number;
  contentType: string;
  body: string;
};

function createFetchMock(
  resources: Record<string, MockResource>,
  callCounter?: Map<string, number>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (callCounter) {
      callCounter.set(requestUrl, (callCounter.get(requestUrl) ?? 0) + 1);
    }

    const resource = resources[requestUrl];
    if (!resource) {
      return new Response("not found", {
        status: 404,
        headers: {
          "content-type": "text/plain",
        },
      });
    }

    return new Response(resource.body, {
      status: resource.status ?? 200,
      headers: {
        "content-type": resource.contentType,
      },
    });
  }) as typeof fetch;
}

describe("Vite dependency map discovery", () => {
  it("extracts map entries from __vite__mapDeps helpers", () => {
    const source =
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["a.js","b.js"])))=>i.map(i=>d[i]);';
    const result = discoverScriptUrlsFromJavaScript(
      source,
      "https://example.com/assets/app-abc.js",
    );

    expect(result.urls).toEqual([
      "https://example.com/assets/a.js",
      "https://example.com/assets/b.js",
    ]);
  });

  it("resolves relative map entries against current script URL", () => {
    const source =
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["utils-def.js","page-ghi.js"])))=>d[i];';
    const result = discoverScriptUrlsFromJavaScript(
      source,
      "https://example.com/assets/app-abc.js",
    );

    expect(result.urls).toEqual([
      "https://example.com/assets/utils-def.js",
      "https://example.com/assets/page-ghi.js",
    ]);
  });

  it("supports root-relative and absolute map entries", () => {
    const source =
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["/assets/x.js","https://cdn.example.com/y.js"])))=>d[i];';
    const result = discoverScriptUrlsFromJavaScript(
      source,
      "https://example.com/assets/app-abc.js",
    );

    expect(result.urls).toEqual([
      "https://example.com/assets/x.js",
      "https://cdn.example.com/y.js",
    ]);
  });

  it("deduplicates repeated dependency entries", () => {
    const source =
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["dup.js","dup.js","other.js"])))=>d[i];';
    const result = discoverScriptUrlsFromJavaScript(
      source,
      "https://example.com/assets/app-abc.js",
    );

    expect(result.urls).toEqual([
      "https://example.com/assets/dup.js",
      "https://example.com/assets/other.js",
    ]);
  });

  it("handles minified helper formatting variants", () => {
    const source =
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["mini-a.js","mini-b.js"])))=>{for(let r=0;r<i.length;r++)i[r]=d[i[r]];return i};';
    const result = discoverScriptUrlsFromJavaScript(
      source,
      "https://example.com/assets/main.js",
    );

    expect(result.urls).toEqual([
      "https://example.com/assets/mini-a.js",
      "https://example.com/assets/mini-b.js",
    ]);
  });

  it("recursively queues and deduplicates Vite dependency map assets", async () => {
    const calls = new Map<string, number>();
    const fetchMock = createFetchMock(
      {
        "https://vite.test/": {
          contentType: "text/html",
          body: `<html><body><script src="/assets/app.js"></script></body></html>`,
        },
        "https://vite.test/assets/app.js": {
          contentType: "application/javascript",
          body: `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["child.js","shared.js"])))=>d[i];`,
        },
        "https://vite.test/assets/child.js": {
          contentType: "application/javascript",
          body: `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["nested.js","shared.js"])))=>d[i];`,
        },
        "https://vite.test/assets/shared.js": {
          contentType: "application/javascript",
          body: `console.log("shared");`,
        },
        "https://vite.test/assets/nested.js": {
          contentType: "application/javascript",
          body: `new EventSource("https://stream.vite.test/events")`,
        },
      },
      calls,
    );

    const collected = await collectSiteSources("https://vite.test/", {
      fetchImpl: fetchMock,
      sameOriginOnly: true,
      maxRemoteFiles: 10,
    });

    const urls = collected.sources.map((source) => source.url).sort();
    expect(urls).toEqual([
      "https://vite.test/assets/app.js",
      "https://vite.test/assets/child.js",
      "https://vite.test/assets/nested.js",
      "https://vite.test/assets/shared.js",
    ]);

    expect(calls.get("https://vite.test/assets/shared.js")).toBe(1);
    expect(collected.errors).toEqual([]);
  });
});
