import * as Sentry from "@sentry/nextjs";

const SENSITIVE_KEY = /authorization|cookie|token|secret|password|api[-_]?key/i;
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Stash a redacted request on the isolation scope.
 * App Router `onRequestError` does not see a body `request.json()` already consumed.
 */
export function recordReplayContext(request: Request, body: unknown): void {
  const url = new URL(request.url);
  Sentry.getIsolationScope().setContext("http_replay", {
    method: request.method,
    path: url.pathname,
    query: url.search,
    contentType: request.headers.get("content-type"),
    body: capBody(redact(body)),
  });
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(child);
    }
    return redacted;
  }
  return value;
}

function capBody(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return { truncated: true };
    }
    if (new TextEncoder().encode(serialized).length > MAX_BODY_BYTES) {
      return { truncated: true };
    }
    return value;
  } catch {
    return { truncated: true };
  }
}
