import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractReplaySpec, PROD_ORIGIN, runHttpReplay, validateHttpReplay, type HttpReplaySpec } from "./replay.js";

const http = {
  kind: "http" as const,
  method: "POST" as const,
  path: "/api/orders",
  contentType: "application/json",
  body: '{"sku":"kenya"}',
  expectStatusMin: 200,
  expectStatusMax: 299,
};

function order(path: string, data: unknown = { sku: "kenya" }) {
  return {
    platform: "node",
    request: {
      method: "POST",
      url: `${PROD_ORIGIN}${path}`,
      data,
      headers: [
        ["Content-Type", "application/json"],
        ["User-Agent", "sentry"],
        ["Cookie", "session"],
      ],
    },
  };
}

describe("validateHttpReplay", () => {
  it("rejects absolute URLs, protocol-relative paths, extra headers, and oversized bodies", () => {
    assert.equal(validateHttpReplay({ ...http, path: "https://evil.example/api/orders" }), null);
    assert.equal(validateHttpReplay({ ...http, path: `${PROD_ORIGIN}/api/orders` }), null);
    assert.equal(validateHttpReplay({ ...http, path: "//evil.com" }), null);
    assert.equal(validateHttpReplay({ ...http, path: "/api/orders\\..\\win" }), null);
    assert.equal(validateHttpReplay({ ...http, path: "/api/orders@evil.com" }), null);
    assert.equal(validateHttpReplay({ ...http, path: "/api/orders x" }), null);
    assert.equal(validateHttpReplay({ ...http, path: "/api/orders\n" }), null);
    assert.equal(validateHttpReplay({ ...http, method: "TRACE" }), null);
    assert.equal(validateHttpReplay({ ...http, headers: { cookie: "session" } }), null);
    assert.equal(validateHttpReplay({ ...http, headers: [["Accept", "application/json"], ["Cookie", "session"]] }), null);
    assert.equal(validateHttpReplay({ ...http, body: "a".repeat(16 * 1024 + 1) }), null);

    const allowed = validateHttpReplay({
      method: "POST",
      path: "/api/orders",
      headers: [
        ["Content-Type", "application/json"],
        ["Accept", "application/json"],
      ],
      body: "a".repeat(16 * 1024),
    });
    assert.equal(allowed?.kind, "http");
    assert.equal(allowed?.contentType, "application/json");
    assert.equal(allowed?.body?.length, 16 * 1024);
  });

  it("does not follow a 3xx redirect", async () => {
    let called = false;
    const redirected = await runHttpReplay({ ...http, expectStatusMax: 399 }, async (input, init) => {
      called = true;
      assert.equal(String(input), `${PROD_ORIGIN}/api/orders`);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.deepEqual(init?.headers, { "content-type": "application/json" });
      return new Response("", { status: 302, headers: { location: "https://evil.example/steal" } });
    });
    assert.equal(called, true);
    assert.equal(redirected.ok, false);
    assert.equal(redirected.status, 302);

    let refused = false;
    const blocked = await runHttpReplay({ ...http, path: "//evil.com" }, async () => {
      refused = true;
      return new Response("no");
    });
    assert.equal(refused, false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 0);
  });

  it("clips a passing response body to 500 characters", async () => {
    const result = await runHttpReplay(http, async () => new Response("x".repeat(800), { status: 200 }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.snippet.length, 500);
  });
});

describe("extractReplaySpec", () => {
  it("prefers http_replay context, then the API request, and never invents a path", () => {
    const preferred = extractReplaySpec({
      contexts: { http_replay: { method: "PUT", path: "/api/from-context", query: "sku=kenya", body: { n: 1 } } },
      ...order("/api/from-request"),
    });
    assert.equal(preferred?.kind, "http");
    if (preferred?.kind === "http") {
      assert.equal(preferred.method, "PUT");
      assert.equal(preferred.path, "/api/from-context?sku=kenya");
      assert.equal(preferred.body, JSON.stringify({ n: 1 }));
    }

    const fromRequest = extractReplaySpec(order("/api/orders"));
    assert.ok(fromRequest);
    const requestSpec: HttpReplaySpec | null = fromRequest?.kind === "http" ? fromRequest : null;
    assert.equal(requestSpec?.path, "/api/orders");
    assert.equal(requestSpec?.contentType, "application/json");
    assert.equal(requestSpec?.body, JSON.stringify({ sku: "kenya" }));
    assert.equal(requestSpec?.expectStatusMin, 200);
    assert.equal(requestSpec?.expectStatusMax, 299);

    const health = extractReplaySpec({
      platform: "node",
      request: { method: "GET", url: `${PROD_ORIGIN}/api/health` },
    });
    assert.equal(health?.kind, "http");
    if (health?.kind === "http") {
      assert.equal(health.method, "GET");
      assert.equal(health.path, "/api/health");
      assert.equal(health.body, undefined);
    }

    assert.equal(extractReplaySpec({}), null);
    assert.equal(extractReplaySpec({ title: "TypeError" }), null);
    assert.equal(
      extractReplaySpec({
        request: { method: "POST", url: "https://evil.example/api/quote", data: { sku: "kenya" } },
      }),
      null,
    );

    const nested = { items: [{ sku: "croissant", quantity: 2 }], promoCode: "VIP10" };
    const fromString = extractReplaySpec({
      contexts: {
        http_replay: {
          method: "POST",
          path: "/api/quote",
          contentType: "application/json",
          body: JSON.stringify(nested),
        },
      },
    });
    assert.equal(fromString?.kind, "http");
    if (fromString?.kind === "http") {
      assert.equal(fromString.body, JSON.stringify(nested));
      assert.equal(fromString.path, "/api/quote");
    }
  });

  it("reads a Sentry REST request entry when event.request is absent", () => {
    const nested = { items: [{ sku: "croissant", quantity: 2 }], promoCode: "VIP10" };
    const spec = extractReplaySpec({
      platform: "node",
      entries: [
        { type: "exception", data: { values: [{ type: "Error", value: "nope" }] } },
        {
          type: "request",
          data: {
            method: "POST",
            url: `${PROD_ORIGIN}/api/quote`,
            data: nested,
            headers: [
              ["Content-Type", "application/json"],
              ["Cookie", "session"],
            ],
          },
        },
      ],
    });
    assert.equal(spec?.kind, "http");
    if (spec?.kind === "http") {
      assert.equal(spec.method, "POST");
      assert.equal(spec.path, "/api/quote");
      assert.equal(spec.contentType, "application/json");
      assert.equal(spec.body, JSON.stringify(nested));
    }
  });

  it("falls through a truncated context and accepts an agent spec", () => {
    const fromRequest = extractReplaySpec(
      {
        contexts: { http_replay: { method: "POST", path: "/api/from-context", body: { truncated: true } } },
        ...order("/api/from-request"),
      },
      { kind: "http", method: "POST", path: "/api/agent", body: "{}" },
    );
    assert.equal(fromRequest?.kind, "http");
    if (fromRequest?.kind === "http") {
      assert.equal(fromRequest.path, "/api/from-request");
    }

    const agent = extractReplaySpec({}, {
      kind: "browser",
      path: "/roast",
      description: "shows the price",
      testPath: "e2e/quote.spec.ts",
    });
    assert.deepEqual(agent, {
      kind: "browser",
      path: "/roast",
      description: "shows the price",
      testPath: "e2e/quote.spec.ts",
    });
    assert.equal(extractReplaySpec({}, { kind: "http", method: "POST", path: "https://evil.example/api/orders", body: "{}" }), null);
    assert.equal(extractReplaySpec({}, { kind: "browser", path: "//evil.com", description: "nope" }), null);
  });

  it("synthesizes a browser check for a non-API page", () => {
    const client = extractReplaySpec({
      platform: "javascript",
      title: "Hydration failed",
      request: { method: "GET", url: `${PROD_ORIGIN}/roast` },
      contexts: { browser: { name: "Firefox" } },
    });
    assert.deepEqual(client, { kind: "browser", path: "/roast", description: "Hydration failed" });

    const page = extractReplaySpec({
      platform: "node",
      title: "Render failed",
      request: { method: "GET", url: `${PROD_ORIGIN}/` },
    });
    assert.equal(page?.kind, "browser");
    if (page?.kind === "browser") {
      assert.equal(page.path, "/");
    }
  });
});
