export async function fetchTextResource(
  resourceUrl: string,
  options: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
  },
): Promise<{
  url: string;
  contentType: string | null;
  body: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await options.fetchImpl(resourceUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "EndpointFinder/0.1",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = await response.text();
    return {
      url: response.url || resourceUrl,
      contentType: response.headers.get("content-type"),
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
}
