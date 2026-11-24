import { isRecord, readString } from "./json.js";

export const QUOTE_PATH = "/api/quote";
export const VERSION_PATH = "/api/version";
export const VERCEL_BYPASS_SECRET_NAME = "VERCEL_AUTOMATION_BYPASS_SECRET";
const VERCEL_BYPASS_HEADER = "x-vercel-protection-bypass";

export const QUOTE_REQUEST = {
  lines: [{ sku: "ethiopia", quantity: 1 }],
  postalCode: "10001",
} as const;

const QUOTE_REQUEST_JSON = JSON.stringify(QUOTE_REQUEST);
const PROJECT = "sentry-autofix-demo";
const TEAM = "rayeds-projects";

export type PreviewVerdict = { kind: "ok" } | { kind: "pending"; reason: string } | { kind: "fail"; reason: string };

export function branchPreviewUrl(branch: string): string {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `https://${PROJECT}-git-${slug}-${TEAM}.vercel.app`;
}

export async function checkPreview(input: {
  branch: string;
  headSha: string;
  fetchImpl?: typeof fetch;
}): Promise<PreviewVerdict> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const origin = branchPreviewUrl(input.branch);
  const version = await request(fetchImpl, new URL(VERSION_PATH, origin), { method: "GET" });
  if (version.kind === "redirect") {
    return { kind: "fail", reason: `GET /api/version redirected (${version.status}).` };
  }
  if (version.kind === "pending") {
    return version;
  }
  if (version.status !== 200) {
    return { kind: "pending", reason: `GET /api/version returned ${version.status}.` };
  }
  const sha = versionSha(version.body);
  if (sha === null || sha !== input.headSha) {
    return { kind: "pending", reason: `Preview SHA ${sha ?? "missing"} is not head ${input.headSha}.` };
  }
  const quote = await request(fetchImpl, new URL(QUOTE_PATH, origin), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: QUOTE_REQUEST_JSON,
  });
  if (quote.kind === "redirect") {
    return { kind: "fail", reason: `POST /api/quote redirected (${quote.status}).` };
  }
  if (quote.kind === "pending") {
    return quote;
  }
  return judgeQuote(quote.status, quote.body, quote.raw);
}

function versionSha(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  return readString(body, "sha");
}

function judgeQuote(status: number, body: unknown, raw: string): PreviewVerdict {
  if (status !== 200 || !isRecord(body)) {
    return { kind: "fail", reason: `POST /api/quote returned ${status}. ${clip(raw)}` };
  }
  const deliveryLabel = readString(body, "deliveryLabel");
  if (deliveryLabel === null || typeof body.delivery !== "number" || !Number.isFinite(body.delivery)) {
    return { kind: "fail", reason: `POST /api/quote returned 200 without a delivery label and numeric delivery. ${clip(raw)}` };
  }
  return { kind: "ok" };
}

type FetchResult =
  | { kind: "http"; status: number; body: unknown; raw: string }
  | { kind: "redirect"; status: number }
  | { kind: "pending"; reason: string };

async function request(fetchImpl: typeof fetch, url: URL, init: RequestInit): Promise<FetchResult> {
  const headers = new Headers(init.headers);
  const bypass = process.env[VERCEL_BYPASS_SECRET_NAME];
  if (bypass !== undefined && bypass.trim() !== "") {
    headers.set(VERCEL_BYPASS_HEADER, bypass.trim());
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "preview request failed";
    return { kind: "pending", reason: message };
  }
  if (response.status >= 300 && response.status < 400) {
    return { kind: "redirect", status: response.status };
  }
  const raw = await response.text();
  let body: unknown = raw;
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = raw;
    }
  }
  return { kind: "http", status: response.status, body, raw };
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
}
