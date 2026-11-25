import { beforeEach, describe, expect, it, vi } from "vitest";

const { setContext } = vi.hoisted(() => ({ setContext: vi.fn() }));

vi.mock("@sentry/nextjs", () => ({
  getIsolationScope: () => ({ setContext }),
}));

import { recordReplayContext } from "./sentry-replay";

function request(): Request {
  return new Request("https://sentry-autofix-demo.vercel.app/api/quote?sku=kenya", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  setContext.mockClear();
});

describe("recordReplayContext", () => {
  it("captures method, path, query, and body", () => {
    recordReplayContext(request(), {
      lines: [{ sku: "kenya", quantity: 1 }],
      postalCode: "10001",
    });

    expect(setContext).toHaveBeenCalledWith("http_replay", {
      method: "POST",
      path: "/api/quote",
      query: "?sku=kenya",
      contentType: "application/json",
      body: {
        lines: [{ sku: "kenya", quantity: 1 }],
        postalCode: "10001",
      },
    });
  });

  it("redacts sensitive keys recursively", () => {
    recordReplayContext(request(), {
      password: "hunter2",
      nested: { api_key: "k", "api-key": "k2", ApiKey: "k3", note: "keep" },
      items: [{ secret: "s", sku: "kenya" }],
      Authorization: "Bearer x",
      cookie: "session",
      tokenCount: 2,
    });

    expect(setContext.mock.calls[0]?.[1]).toMatchObject({
      body: {
        password: "[redacted]",
        nested: { api_key: "[redacted]", "api-key": "[redacted]", ApiKey: "[redacted]", note: "keep" },
        items: [{ secret: "[redacted]", sku: "kenya" }],
        Authorization: "[redacted]",
        cookie: "[redacted]",
        tokenCount: "[redacted]",
      },
    });
  });

  it("replaces a serialized body over 8 KB with a truncation marker", () => {
    recordReplayContext(request(), { note: "a".repeat(7_000) });
    expect(setContext.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      path: "/api/quote",
      body: { note: "a".repeat(7_000) },
    });

    setContext.mockClear();
    recordReplayContext(request(), { note: "a".repeat(9_000) });
    expect(setContext.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      path: "/api/quote",
      body: { truncated: true },
    });
  });
});
