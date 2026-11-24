import { isRecord, readString } from "./json.js";

export const QUOTE_PATH = "/api/quote";
export const VERCEL_BYPASS_SECRET_NAME = "VERCEL_AUTOMATION_BYPASS_SECRET";
export const VERCEL_BYPASS_HEADER = "x-vercel-protection-bypass";

export const QUOTE_REQUEST = {
  lines: [{ sku: "ethiopia", quantity: 1 }],
  postalCode: "10001",
} as const;

export const QUOTE_REQUEST_JSON = JSON.stringify(QUOTE_REQUEST);

const VERCEL_PROJECT = "sentry-autofix-demo";
const VERCEL_TEAM = "rayeds-projects";

export type DeployState = "success" | "failure" | "pending";

export type PreviewHit = {
  sha: string;
  state: DeployState;
  url: string | null;
  preview: boolean;
};

export type QuoteVerdict =
  | { ok: true; deliveryLabel: string; delivery: number }
  | { ok: false; status: number; reason: string; body: string };

export function vercelPreviewUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!isPreviewHost(host)) {
    return null;
  }
  return `https://${host}`;
}

export function isPreviewHost(hostname: string): boolean {
  return hostname.endsWith(".vercel.app") && hostname.includes("-git-");
}

/** Vercel branch alias. `cursor/repro-6-1efe` -> the preview host used for that branch. */
export function branchPreviewUrl(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `https://${VERCEL_PROJECT}-git-${slug}-${VERCEL_TEAM}.vercel.app`;
}

export function resolvePreviewUrl(hit: { state: DeployState; url: string | null }, branch: string): string | null {
  if (hit.url !== null) {
    return hit.url;
  }
  if (hit.state !== "success") {
    return null;
  }
  const fallback = branchPreviewUrl(branch);
  return vercelPreviewUrl(fallback);
}

export function previewFromParts(input: {
  sha: string;
  state: string;
  environment?: string | null;
  production?: boolean;
  environmentUrl?: string | null;
  targetUrl?: string | null;
}): PreviewHit | null {
  const sha = input.sha.trim();
  if (sha === "") {
    return null;
  }
  const state = mapDeployState(input.state);
  if (state === null) {
    return null;
  }
  const url = vercelPreviewUrl(input.environmentUrl) ?? vercelPreviewUrl(input.targetUrl);
  const kind = environmentKind(input.environment ?? null, input.production === true);
  return {
    sha,
    state,
    url,
    preview: kind === "preview" || (kind !== "production" && url !== null),
  };
}

export function previewFromDeploymentStatusPayload(payload: unknown): PreviewHit | null {
  if (!isRecord(payload) || !isRecord(payload.deployment) || !isRecord(payload.deployment_status)) {
    return null;
  }
  const sha = readString(payload.deployment, "sha");
  if (sha === null) {
    return null;
  }
  const status = payload.deployment_status;
  return previewFromParts({
    sha,
    state: readString(status, "state") ?? "pending",
    environment: readString(status, "environment") ?? readString(payload.deployment, "environment"),
    production:
      payload.deployment.production_environment === true ||
      payload.deployment_status.environment === "Production",
    environmentUrl: readString(status, "environment_url"),
    targetUrl: readString(status, "target_url"),
  });
}

export function deploymentSha(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.deployment)) {
    return null;
  }
  return readString(payload.deployment, "sha");
}

export function previewFromCommitStatus(input: {
  sha: string;
  state: string;
  context: string;
  targetUrl?: string | null;
}): PreviewHit | null {
  if (!/vercel/i.test(input.context)) {
    return null;
  }
  return previewFromParts({
    sha: input.sha,
    state: input.state,
    environment: "Preview",
    targetUrl: input.targetUrl,
  });
}

export function choosePreview(hits: readonly PreviewHit[]): PreviewHit | null {
  const previews = hits.filter((hit) => hit.preview);
  const ready = previews.find((hit) => hit.state === "success" && hit.url !== null);
  if (ready !== undefined) {
    return ready;
  }
  const failed = previews.find((hit) => hit.state === "failure");
  if (failed !== undefined) {
    return failed;
  }
  const pending = previews.find((hit) => hit.state === "pending" || hit.state === "success");
  return pending ?? null;
}

export function isPreviewProtection(verdict: QuoteVerdict): boolean {
  return !verdict.ok && verdict.status === 401 && verdict.body.includes("Protected deployment");
}

export function judgeQuoteResponse(status: number, body: unknown, raw = ""): QuoteVerdict {
  if (status !== 200) {
    return { ok: false, status, reason: `HTTP ${status}.`, body: clipBody(raw) };
  }
  if (!isRecord(body)) {
    return { ok: false, status, reason: "Response was not a JSON object.", body: clipBody(raw) };
  }
  const deliveryLabel = readString(body, "deliveryLabel");
  if (deliveryLabel === null) {
    return { ok: false, status, reason: "Response has no delivery label.", body: clipBody(raw) };
  }
  const delivery = body.delivery;
  if (typeof delivery !== "number" || !Number.isFinite(delivery)) {
    return { ok: false, status, reason: "Response delivery is not a number.", body: clipBody(raw) };
  }
  return { ok: true, deliveryLabel, delivery };
}

export async function verifyPreviewQuote(
  previewUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QuoteVerdict> {
  const origin = vercelPreviewUrl(previewUrl);
  if (origin === null) {
    return { ok: false, status: 0, reason: "Preview URL is not a Vercel preview host.", body: previewUrl };
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  const bypass = process.env[VERCEL_BYPASS_SECRET_NAME];
  if (bypass !== undefined && bypass.trim() !== "") {
    headers[VERCEL_BYPASS_HEADER] = bypass.trim();
  }
  const response = await fetchImpl(new URL(QUOTE_PATH, origin), {
    method: "POST",
    headers,
    body: QUOTE_REQUEST_JSON,
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let parsed: unknown = raw;
  if (raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = raw;
    }
  }
  return judgeQuoteResponse(response.status, parsed, raw);
}

function mapDeployState(state: string): DeployState | null {
  switch (state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "inactive":
      return null;
    case "pending":
    case "queued":
    case "in_progress":
    case "waiting":
      return "pending";
    default:
      return "pending";
  }
}

function environmentKind(environment: string | null, productionFlag: boolean): "preview" | "production" | "unknown" {
  if (productionFlag) {
    return "production";
  }
  if (environment === null) {
    return "unknown";
  }
  const value = environment.toLowerCase();
  if (value.includes("production")) {
    return "production";
  }
  if (value.includes("preview")) {
    return "preview";
  }
  return "unknown";
}

function clipBody(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 1500) {
    return trimmed;
  }
  return `${trimmed.slice(0, 1500)}\n…`;
}
