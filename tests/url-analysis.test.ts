import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeUrlTarget } from "../src/analysis/analyzeUrl";

type MockResource = {
  status?: number;
  contentType: string;
  body: string;
};

function createFetchMock(resources: Record<string, MockResource>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

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

describe("URL target analysis", () => {
  it("analyzes remote sources directly", async () => {
    const fetchMock = createFetchMock({
      "https://app.test/": {
        contentType: "text/html",
        body: `<html><head></head><body><script src="/assets/main.js"></script></body></html>`,
      },
      "https://app.test/assets/main.js": {
        contentType: "application/javascript",
        body: `import("./chunk.js"); const BASE = "https://api.test"; fetch(BASE + "/users");`,
      },
      "https://app.test/assets/chunk.js": {
        contentType: "application/javascript",
        body: `new EventSource("https://stream.test/events")`,
      },
    });

    const result = await analyzeUrlTarget("https://app.test/", {
      fetchImpl: fetchMock,
      siteMode: "direct",
    });

    expect(result.sourceMode).toBe("url-direct");
    expect(result.filesAnalyzed).toBe(2);
    expect(result.findings.length).toBe(2);
    expect(result.findings.some((finding) => finding.url === "https://api.test/users")).toBe(
      true,
    );
    expect(
      result.findings.some((finding) => finding.url === "https://stream.test/events"),
    ).toBe(true);
  });

  it("clones remote sources before analysis", async () => {
    const fetchMock = createFetchMock({
      "https://clone.test/": {
        contentType: "text/html",
        body: `<html><body><script src="/bundle.js"></script></body></html>`,
      },
      "https://clone.test/bundle.js": {
        contentType: "application/javascript",
        body: `new WebSocket("wss://socket.clone.test/ws")`,
      },
    });

    const cloneRoot = await mkdtemp(path.join(os.tmpdir(), "endpointfinder-clone-"));
    try {
      const result = await analyzeUrlTarget("https://clone.test/", {
        fetchImpl: fetchMock,
        siteMode: "clone",
        cloneDir: cloneRoot,
      });

      expect(result.sourceMode).toBe("url-clone");
      expect(result.clonedTo).toBeDefined();
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings[0].url).toBe("wss://socket.clone.test/ws");
      expect(result.findings[0].file.startsWith(result.clonedTo!)).toBe(true);

      await expect(stat(path.join(cloneRoot, "clone-manifest.json"))).resolves.toBeDefined();
    } finally {
      await rm(cloneRoot, { recursive: true, force: true });
    }
  });

  it("resolves Next.js static chunk strings without duplicate path segments", async () => {
    const fetchMock = createFetchMock({
      "https://next.test/": {
        contentType: "text/html",
        body: `<html><body><script src="/_next/static/chunks/main.js"></script></body></html>`,
      },
      "https://next.test/_next/static/chunks/main.js": {
        contentType: "application/javascript",
        body: `const chunkRef = "static/chunks/child.js"; fetch("https://api.next.test/ok");`,
      },
      "https://next.test/_next/static/chunks/child.js": {
        contentType: "application/javascript",
        body: `new WebSocket("wss://socket.next.test/ws")`,
      },
    });

    const result = await analyzeUrlTarget("https://next.test/", {
      fetchImpl: fetchMock,
      siteMode: "direct",
    });

    expect(result.filesAnalyzed).toBe(2);
    expect(
      result.errors.some((error) => error.file.includes("/static/chunks/static/chunks/")),
    ).toBe(false);
    expect(result.findings.some((finding) => finding.url === "https://api.next.test/ok")).toBe(
      true,
    );
    expect(
      result.findings.some((finding) => finding.url === "wss://socket.next.test/ws"),
    ).toBe(true);
  });
});
