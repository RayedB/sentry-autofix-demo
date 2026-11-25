import type { JsonObject } from "@grok/agent-sdk";
import { isRecord, readString } from "./json.js";

export const PROD_ORIGIN = "https://sentry-autofix-demo.vercel.app";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof METHODS)[number];

const METHOD_SET: ReadonlySet<string> = new Set(METHODS);
const HEADER_ALLOW = new Set(["content-type", "accept"]);
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_MIN = 200;
const DEFAULT_MAX = 299;
const UNSAFE = /[\s\u0000-\u001F\u007F\\@]/;

export type HttpReplaySpec = {
  kind: "http";
  method: HttpMethod;
  path: string;
  contentType?: string;
  body?: string;
  expectStatusMin: number;
  expectStatusMax: number;
};

export type BrowserReplaySpec = {
  kind: "browser";
  path: string;
  description: string;
  testPath?: string;
};

export type ReplaySpec = HttpReplaySpec | BrowserReplaySpec;

export type ReplayResult = {
  ok: boolean;
  status: number;
  snippet: string;
};

export function isSafeProdPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }
  if (path.includes("://") || UNSAFE.test(path)) {
    return false;
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (decoded.startsWith("//") || decoded.includes("://") || UNSAFE.test(decoded)) {
    return false;
  }
  try {
    const url = new URL(path, PROD_ORIGIN);
    return url.origin === PROD_ORIGIN;
  } catch {
    return false;
  }
}

export function isSafeTestPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) {
    return false;
  }
  if (path.startsWith("/") || path.includes("..") || path.includes("\\") || path.includes("://")) {
    return false;
  }
  if (UNSAFE.test(path)) {
    return false;
  }
  return /^[A-Za-z0-9_./-]+$/.test(path);
}

/** Accept only a relative same-origin request. Absolute URLs and extra headers are rejected. */
export function validateHttpReplay(raw: unknown): HttpReplaySpec | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.kind !== undefined && raw.kind !== "http") {
    return null;
  }
  const methodRaw = plainString(raw.method);
  if (methodRaw === null || !METHOD_SET.has(methodRaw.toUpperCase())) {
    return null;
  }
  const method = methodRaw.toUpperCase() as HttpMethod;
  const path = plainString(raw.path);
  if (path === null || !isSafeProdPath(path)) {
    return null;
  }
  if (!headersAllowed(raw.headers)) {
    return null;
  }
  const contentType = contentTypeOf(raw);
  if (contentType === undefined) {
    return null;
  }
  const body = bodyOf(raw.body);
  if (body === undefined) {
    return null;
  }
  const range = statusRange(raw);
  if (range === null) {
    return null;
  }
  const spec: HttpReplaySpec = {
    kind: "http",
    method,
    path,
    expectStatusMin: range.min,
    expectStatusMax: range.max,
  };
  if (contentType !== null) {
    spec.contentType = contentType;
  }
  if (body !== null) {
    spec.body = body;
  }
  return spec;
}

export function validateBrowserReplay(raw: unknown): BrowserReplaySpec | null {
  if (!isRecord(raw) || raw.kind !== "browser") {
    return null;
  }
  const path = plainString(raw.path);
  const description = readString(raw, "description");
  if (path === null || !isSafeProdPath(path) || description === null || description.length > 2_000) {
    return null;
  }
  const spec: BrowserReplaySpec = { kind: "browser", path, description };
  if (raw.testPath === undefined || raw.testPath === null) {
    return spec;
  }
  const testPath = plainString(raw.testPath);
  if (testPath === null || !isSafeTestPath(testPath)) {
    return null;
  }
  spec.testPath = testPath;
  return spec;
}

export function parseAgentReplay(raw: unknown): ReplaySpec | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.kind === "http") {
    return validateHttpReplay(raw);
  }
  if (raw.kind === "browser") {
    return validateBrowserReplay(raw);
  }
  return null;
}

/**
 * Prefer the redacted `http_replay` context, then a same-origin API request,
 * then a Phase 1 agent spec, then a browser page. Never invents a path.
 */
export function extractReplaySpec(event: unknown, agentReplay?: unknown): ReplaySpec | null {
  const record = isRecord(event) ? event : {};
  const fromContext = httpFromContext(record.contexts);
  if (fromContext !== null) {
    return fromContext;
  }
  const fromRequest = httpFromRequest(record.request);
  if (fromRequest !== null) {
    return fromRequest;
  }
  const fromAgent = parseAgentReplay(agentReplay);
  if (fromAgent !== null) {
    return fromAgent;
  }
  return browserFromEvent(record);
}

export async function runHttpReplay(spec: HttpReplaySpec, fetchImpl: typeof fetch = fetch): Promise<ReplayResult> {
  if (!METHOD_SET.has(spec.method) || !isSafeProdPath(spec.path)) {
    return { ok: false, status: 0, snippet: "rejected replay target" };
  }
  if (spec.body !== undefined && byteLength(spec.body) > MAX_BODY_BYTES) {
    return { ok: false, status: 0, snippet: "rejected replay body" };
  }
  const url = new URL(spec.path, PROD_ORIGIN);
  if (url.origin !== PROD_ORIGIN) {
    return { ok: false, status: 0, snippet: "rejected replay target" };
  }
  const headers: Record<string, string> = {};
  if (spec.contentType !== undefined) {
    headers["content-type"] = spec.contentType;
  }
  const response = await fetchImpl(url.toString(), {
    method: spec.method,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers,
    body: spec.body !== undefined && spec.method !== "GET" ? spec.body : undefined,
  });
  const snippet = (await response.text()).slice(0, 500);
  const status = response.status;
  const redirect = status >= 300 && status < 400;
  const inRange = status >= spec.expectStatusMin && status <= spec.expectStatusMax;
  return { ok: inRange && !redirect, status, snippet };
}

export function replayToJson(spec: ReplaySpec): JsonObject {
  switch (spec.kind) {
    case "http":
      return {
        kind: "http",
        method: spec.method,
        path: spec.path,
        expectStatusMin: spec.expectStatusMin,
        expectStatusMax: spec.expectStatusMax,
        ...(spec.contentType !== undefined ? { contentType: spec.contentType } : {}),
        ...(spec.body !== undefined ? { body: spec.body } : {}),
      };
    case "browser":
      return {
        kind: "browser",
        path: spec.path,
        description: spec.description,
        ...(spec.testPath !== undefined ? { testPath: spec.testPath } : {}),
      };
    default: {
      const unknown: never = spec;
      return unknown;
    }
  }
}

function httpFromContext(contexts: unknown): HttpReplaySpec | null {
  if (!isRecord(contexts) || !isRecord(contexts.http_replay)) {
    return null;
  }
  const raw = contexts.http_replay;
  if (isTruncationMarker(raw.body)) {
    return null;
  }
  const path = plainString(raw.path);
  if (path === null) {
    return null;
  }
  return validateHttpReplay({
    ...raw,
    kind: "http",
    path: joinQuery(path, plainString(raw.query)),
  });
}

function httpFromRequest(request: unknown): HttpReplaySpec | null {
  if (!isRecord(request)) {
    return null;
  }
  const methodRaw = plainString(request.method);
  const url = plainString(request.url);
  if (methodRaw === null || url === null || !METHOD_SET.has(methodRaw.toUpperCase())) {
    return null;
  }
  const path = relativeProdPath(url);
  if (path === null) {
    return null;
  }
  const pathname = path.split("?")[0] ?? path;
  const body = dataToBody(request.data);
  const method = methodRaw.toUpperCase();
  const allowsEmpty = method === "GET" || method === "DELETE";
  if (!allowsEmpty && body === null) {
    return null;
  }
  // A page GET is a browser check. API calls and requests with a body stay HTTP.
  if (!pathname.startsWith("/api/") && body === null) {
    return null;
  }
  const contentType = contentTypeFromRequest(request);
  return validateHttpReplay({
    kind: "http",
    method,
    path,
    ...(contentType !== null ? { contentType } : {}),
    ...(body !== null ? { body } : {}),
  });
}

function browserFromEvent(event: Record<string, unknown>): BrowserReplaySpec | null {
  if (hasApiPost(event)) {
    return null;
  }
  const path = pagePath(event);
  if (path === null) {
    return null;
  }
  const description = readString(event, "title") ?? readString(event, "culprit") ?? "Client-side error";
  return { kind: "browser", path, description: description.slice(0, 500) };
}

function hasApiPost(event: Record<string, unknown>): boolean {
  return httpFromRequest(event.request)?.kind === "http";
}

function pagePath(event: Record<string, unknown>): string | null {
  const requestUrl = isRecord(event.request) ? plainString(event.request.url) : null;
  const tagged = tagValue(event, "url");
  const candidates = [
    requestUrl === null ? null : relativeProdPath(requestUrl),
    tagged === null ? null : tagged.startsWith("/") ? tagged : relativeProdPath(tagged),
    pathFromLabel(readString(event, "transaction")),
    pathFromLabel(readString(event, "culprit")),
  ];
  for (const candidate of candidates) {
    if (candidate === null) {
      continue;
    }
    const path = candidate.split("?")[0] ?? candidate;
    if (!isSafeProdPath(path) || path.startsWith("/api/") || path === "/api") {
      continue;
    }
    return path;
  }
  return null;
}

function pathFromLabel(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const match = /^(?:GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)$/.exec(value);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  if (value.startsWith("/")) {
    return value.split(/\s/)[0] ?? null;
  }
  return null;
}

function relativeProdPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== PROD_ORIGIN) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function joinQuery(path: string, query: string | null): string {
  if (query === null || query === "" || path.includes("?")) {
    return path;
  }
  return `${path}${query.startsWith("?") ? query : `?${query}`}`;
}

function contentTypeFromRequest(request: Record<string, unknown>): string | null {
  const inferred = readString(request, "inferred_content_type") ?? readString(request, "inferredContentType");
  if (inferred !== null && !/[\r\n]/.test(inferred)) {
    return inferred;
  }
  return headerValue(request.headers, "content-type");
}

function headersAllowed(headers: unknown): boolean {
  if (headers === undefined || headers === null) {
    return true;
  }
  const names = headerNames(headers);
  if (names === null) {
    return false;
  }
  return names.every((name) => HEADER_ALLOW.has(name.toLowerCase()));
}

function headerNames(headers: unknown): string[] | null {
  if (Array.isArray(headers)) {
    const names: string[] = [];
    for (const entry of headers) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") {
        return null;
      }
      names.push(entry[0]);
    }
    return names;
  }
  if (!isRecord(headers)) {
    return null;
  }
  return Object.keys(headers);
}

function headerValue(headers: unknown, name: string): string | null {
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
        continue;
      }
      if (entry[0].toLowerCase() === wanted && !/[\r\n]/.test(entry[1])) {
        return entry[1];
      }
    }
    return null;
  }
  if (!isRecord(headers)) {
    return null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === "string" && !/[\r\n]/.test(value)) {
      return value;
    }
  }
  return null;
}

function contentTypeOf(raw: Record<string, unknown>): string | null | undefined {
  const direct = plainString(raw.contentType) ?? plainString(raw["content-type"]);
  const fromHeaders = headerValue(raw.headers, "content-type");
  const value = direct ?? fromHeaders;
  if (value === null) {
    return null;
  }
  if (value.length > 200 || /[\r\n\u0000]/.test(value)) {
    return undefined;
  }
  return value;
}

/** `null` is absent. `undefined` is rejected (oversized or not serializable). */
function bodyOf(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    if (byteLength(value) > MAX_BODY_BYTES) {
      return undefined;
    }
    return value.length === 0 ? null : value;
  }
  let text: string;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return undefined;
    }
    text = serialized;
  } catch {
    return undefined;
  }
  if (byteLength(text) > MAX_BODY_BYTES) {
    return undefined;
  }
  return text;
}

function dataToBody(data: unknown): string | null {
  const body = bodyOf(data);
  if (body === undefined || body === null || body === "{}" || body === "[]") {
    return null;
  }
  return body;
}

function statusRange(raw: Record<string, unknown>): { min: number; max: number } | null {
  const min = raw.expectStatusMin === undefined ? DEFAULT_MIN : raw.expectStatusMin;
  const max = raw.expectStatusMax === undefined ? DEFAULT_MAX : raw.expectStatusMax;
  if (typeof min !== "number" || typeof max !== "number" || !Number.isInteger(min) || !Number.isInteger(max)) {
    return null;
  }
  if (min < 100 || max > 599 || min > max) {
    return null;
  }
  return { min, max };
}

function isTruncationMarker(value: unknown): boolean {
  return isRecord(value) && value.truncated === true;
}

function plainString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function tagValue(event: Record<string, unknown>, key: string): string | null {
  const tags = event.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === "string") {
        return tag[1];
      }
      if (isRecord(tag) && (tag.key === key || tag.name === key) && typeof tag.value === "string") {
        return tag.value;
      }
    }
  }
  if (isRecord(tags) && typeof tags[key] === "string") {
    return tags[key];
  }
  return null;
}
