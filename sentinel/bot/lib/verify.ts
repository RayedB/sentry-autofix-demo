import type { JsonObject, JsonValue } from "@grok/agent-sdk";
import { isStopped } from "./cloud-status.js";
import { GITHUB_FULL_NAME } from "./github.js";
import { isRecord, readNumber, readString } from "./json.js";
import { parsePrLink, prLinkKey, refsIssueNumber, sentryIssueIdFromText } from "./links.js";
import { PROD_ORIGIN, runHttpReplay, type ReplaySpec } from "./replay.js";

const REPRO_LABEL = "sentry-repro";
const SHA = /^[0-9a-f]{7,64}$/i;
const STALE_MS = 24 * 60 * 60 * 1000;
const DEPLOY_MS = 30 * 60 * 1000;
const BROWSER_MS = 15 * 60 * 1000;

export type VerifyPhase = "waiting_deploy" | "verifying_browser" | "replayed" | "resolved" | "failed";

export type VerifyRecord = {
  prNumber: number;
  phase: VerifyPhase;
  sentryIssueId: string | null;
  githubIssueNumber: number | null;
  mergeCommitSha: string;
  mergedAt: string;
  prodSha: string | null;
  replayMode: "http" | "browser" | null;
  replaySummary: string | null;
  replayedAt: string | null;
  agentId: string | null;
  agentUrl: string | null;
  startedAt: string | null;
  failure: string | null;
};

export type ClosedPull = {
  number: number;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  baseRef: string;
  headRepoFullName: string | null;
  labels: string[];
  body: string | null;
  title: string;
  htmlUrl: string;
};

export type VerifyGitHub = {
  compareStatus(base: string, head: string): Promise<string | null>;
  comment(number: number, body: string): Promise<void>;
  getIssue(number: number): Promise<{ body: string | null; state: string } | null>;
  closeIssue(number: number): Promise<void>;
};

export type AgentView = {
  status: string;
  result?: string;
  url?: string;
  error?: string;
};

export type LaunchVerifyInput = {
  prNumber: number;
  path: string;
  description: string;
  testPath: string | null;
  prodSha: string;
};

export type SentryClient = {
  fetchIssue(issueId: string): Promise<{ replay: ReplaySpec | null }>;
  listProductionEvents(issueId: string, sinceIso: string, prodSha: string): Promise<Array<{ id: string }>>;
  resolveIssue(issueId: string): Promise<void>;
};

export type VerifyDeps = {
  kv: {
    get(key: string): Promise<JsonValue | undefined>;
    put(key: string, value: JsonValue): Promise<void>;
  };
  github: VerifyGitHub;
  getAgent(agentId: string): Promise<AgentView>;
  launch(input: LaunchVerifyInput): Promise<{ agentId: string; url: string }>;
  sentry: SentryClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type TrackedPull = ClosedPull & { mergedAt: string; mergeCommitSha: string };

type Linked = {
  sentryIssueId: string | null;
  githubIssueNumber: number | null;
  testPath: string | null;
  replay: ReplaySpec | null;
};

/** One pass over one closed pull request. At most one phase change. No sleep. */
export async function verifyTick(deps: VerifyDeps, pull: ClosedPull): Promise<void> {
  if (!isTrackedPull(pull)) {
    return;
  }
  const existing = parseVerifyRecord(await deps.kv.get(verifyKey(pull.number)));
  const now = deps.now?.() ?? Date.now();
  if (existing?.phase === "resolved" || existing?.phase === "failed") {
    return;
  }
  if (isStale(pull, existing, now)) {
    return;
  }

  const phase = existing?.phase ?? "waiting_deploy";
  switch (phase) {
    case "verifying_browser":
      if (existing === null) {
        return;
      }
      await stepBrowser(deps, existing, pull, now);
      return;
    case "replayed":
      if (existing === null) {
        return;
      }
      await stepReplayed(deps, existing, pull);
      return;
    case "waiting_deploy":
      await stepWaiting(deps, existing, pull, now);
      return;
    default: {
      const unknown: never = phase;
      return unknown;
    }
  }
}

export function verifyKey(prNumber: number): string {
  return `sentinel:verify:pr:${prNumber}`;
}

export function parseVerifyRecord(value: unknown): VerifyRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const prNumber = readNumber(value, "prNumber");
  const phase = readString(value, "phase");
  const mergeCommitSha = readString(value, "mergeCommitSha");
  const mergedAt = readString(value, "mergedAt");
  if (
    prNumber === null ||
    !Number.isInteger(prNumber) ||
    mergeCommitSha === null ||
    mergedAt === null ||
    !isPhase(phase)
  ) {
    return null;
  }
  const issueNumber = readNumber(value, "githubIssueNumber");
  return {
    prNumber,
    phase,
    sentryIssueId: readString(value, "sentryIssueId"),
    githubIssueNumber: issueNumber !== null && Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null,
    mergeCommitSha,
    mergedAt,
    prodSha: readString(value, "prodSha"),
    replayMode: value.replayMode === "http" || value.replayMode === "browser" ? value.replayMode : null,
    replaySummary: typeof value.replaySummary === "string" ? value.replaySummary : null,
    replayedAt: readString(value, "replayedAt"),
    agentId: readString(value, "agentId"),
    agentUrl: typeof value.agentUrl === "string" ? value.agentUrl : null,
    startedAt: readString(value, "startedAt"),
    failure: typeof value.failure === "string" ? value.failure : null,
  };
}

async function stepWaiting(deps: VerifyDeps, existing: VerifyRecord | null, pull: TrackedPull, now: number): Promise<void> {
  const linked = await resolveLink(deps, pull);
  const record = withLink(existing, pull, linked);
  if (linked.replay === null || linked.sentryIssueId === null) {
    const reason =
      linked.replay === null
        ? "No safe production replay descriptor was found for this merge."
        : "No Sentry issue id was linked to this pull request.";
    await fail(deps, pull, record, reason);
    return;
  }
  if (now - Date.parse(pull.mergedAt) > DEPLOY_MS) {
    await fail(deps, pull, record, `Production did not serve merge ${pull.mergeCommitSha} within 30 minutes.`);
    return;
  }
  const prodSha = await readProdSha(deps.fetchImpl ?? fetch);
  if (prodSha === null || !(await deployReady(deps, pull.mergeCommitSha, prodSha))) {
    await save(deps, { ...record, phase: "waiting_deploy", prodSha, failure: null });
    return;
  }
  const replay = linked.replay;
  switch (replay.kind) {
    case "http":
      await replayHttp(deps, pull, record, replay, prodSha, now);
      return;
    case "browser":
      await launchBrowser(deps, pull, record, replay, linked.testPath, prodSha, now);
      return;
    default: {
      const unknown: never = replay;
      return unknown;
    }
  }
}

async function stepBrowser(deps: VerifyDeps, record: VerifyRecord, pull: TrackedPull, now: number): Promise<void> {
  if (record.agentId === null) {
    await fail(deps, pull, record, "Browser verification did not record an agent id.");
    return;
  }
  const timedOut = record.startedAt !== null && now - Date.parse(record.startedAt) > BROWSER_MS;
  const agent = await deps.getAgent(record.agentId);
  if (!isStopped(agent.status)) {
    if (timedOut) {
      await fail(
        deps,
        pull,
        record,
        `Browser verification timed out after 15 minutes. Agent: ${agent.url ?? record.agentUrl ?? ""}`.trim(),
      );
    }
    return;
  }
  const parsed = parseBrowserResult(agent.result);
  const url = agent.url ?? record.agentUrl ?? "";
  if (parsed === null || !parsed.passed) {
    const summary = parsed?.summary || agent.error || "The cloud agent did not return JSON.";
    await fail(deps, pull, { ...record, agentUrl: url || record.agentUrl }, `Browser verification failed. Agent: ${url} ${summary}`.trim());
    return;
  }
  await save(deps, {
    ...record,
    phase: "replayed",
    agentUrl: url || record.agentUrl,
    replayedAt: new Date(now).toISOString(),
    replayMode: "browser",
    replaySummary: parsed.summary,
    failure: null,
  });
}

async function stepReplayed(deps: VerifyDeps, record: VerifyRecord, pull: TrackedPull): Promise<void> {
  if (record.sentryIssueId === null || record.replayedAt === null || record.prodSha === null) {
    await fail(deps, pull, record, "Production replay finished without a Sentry issue to check.");
    return;
  }
  const events = await deps.sentry.listProductionEvents(record.sentryIssueId, record.replayedAt, record.prodSha);
  if (events.length > 0) {
    await fail(deps, pull, record, `Production Sentry events after replay: ${events.map((event) => event.id).join(", ")}.`);
    return;
  }
  await deps.sentry.resolveIssue(record.sentryIssueId);
  const resolved = { ...record, phase: "resolved" as const, failure: null };
  await commentBoth(deps, pull.number, record.githubIssueNumber, successComment(resolved));
  if (record.githubIssueNumber !== null) {
    const issue = await deps.github.getIssue(record.githubIssueNumber);
    if (issue !== null && issue.state === "open") {
      await deps.github.closeIssue(record.githubIssueNumber);
    }
  }
  await save(deps, resolved);
}

async function replayHttp(
  deps: VerifyDeps,
  pull: TrackedPull,
  record: VerifyRecord,
  spec: Extract<ReplaySpec, { kind: "http" }>,
  prodSha: string,
  now: number,
): Promise<void> {
  const result = await runHttpReplay(spec, deps.fetchImpl ?? fetch);
  if (!result.ok) {
    await fail(
      deps,
      pull,
      { ...record, prodSha },
      `HTTP replay ${spec.method} ${spec.path} against ${PROD_ORIGIN} returned ${result.status}. ${clip(result.snippet, 200)}`.trim(),
    );
    return;
  }
  await save(deps, {
    ...record,
    phase: "replayed",
    prodSha,
    replayedAt: new Date(now).toISOString(),
    replayMode: "http",
    replaySummary: `${spec.method} ${spec.path} returned ${result.status}`,
    failure: null,
  });
}

async function launchBrowser(
  deps: VerifyDeps,
  pull: TrackedPull,
  record: VerifyRecord,
  spec: Extract<ReplaySpec, { kind: "browser" }>,
  linkTestPath: string | null,
  prodSha: string,
  now: number,
): Promise<void> {
  const launched = await deps.launch({
    prNumber: pull.number,
    path: spec.path,
    description: spec.description,
    testPath: spec.testPath ?? linkTestPath,
    prodSha,
  });
  await save(deps, {
    ...record,
    phase: "verifying_browser",
    prodSha,
    agentId: launched.agentId,
    agentUrl: launched.url,
    startedAt: new Date(now).toISOString(),
    replayMode: "browser",
    failure: null,
  });
}

async function resolveLink(deps: VerifyDeps, pull: TrackedPull): Promise<Linked> {
  const stored = parsePrLink(await deps.kv.get(prLinkKey(pull.number)));
  if (stored !== null) {
    const replay = stored.replay ?? (await deps.sentry.fetchIssue(stored.sentryIssueId)).replay;
    return {
      sentryIssueId: stored.sentryIssueId,
      githubIssueNumber: stored.githubIssueNumber,
      testPath: stored.testPath,
      replay,
    };
  }
  const issueNumber = refsIssueNumber(pull.body) ?? refsIssueNumber(pull.title);
  if (issueNumber === null) {
    return { sentryIssueId: null, githubIssueNumber: null, testPath: null, replay: null };
  }
  const issue = await deps.github.getIssue(issueNumber);
  const sentryIssueId = sentryIssueIdFromText(issue?.body ?? null);
  if (sentryIssueId === null) {
    return { sentryIssueId: null, githubIssueNumber: issueNumber, testPath: null, replay: null };
  }
  const snap = await deps.sentry.fetchIssue(sentryIssueId);
  return { sentryIssueId, githubIssueNumber: issueNumber, testPath: null, replay: snap.replay };
}

async function deployReady(deps: VerifyDeps, mergeSha: string, prodSha: string): Promise<boolean> {
  if (prodSha === mergeSha) {
    return true;
  }
  const status = await deps.github.compareStatus(mergeSha, prodSha);
  return status === "ahead" || status === "identical";
}

async function readProdSha(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${PROD_ORIGIN}/api/version`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      return null;
    }
    const sha = readString(body, "sha");
    if (sha === null || !SHA.test(sha)) {
      return null;
    }
    return sha;
  } catch {
    return null;
  }
}

async function fail(deps: VerifyDeps, pull: TrackedPull, record: VerifyRecord, reason: string): Promise<void> {
  const failed: VerifyRecord = { ...record, phase: "failed", failure: reason };
  await save(deps, failed);
  await commentBoth(deps, pull.number, failed.githubIssueNumber, failureComment(failed));
}

async function commentBoth(deps: VerifyDeps, prNumber: number, issueNumber: number | null, body: string): Promise<void> {
  await deps.github.comment(prNumber, body);
  if (issueNumber !== null && issueNumber !== prNumber) {
    await deps.github.comment(issueNumber, body);
  }
}

async function save(deps: VerifyDeps, record: VerifyRecord): Promise<void> {
  await deps.kv.put(verifyKey(record.prNumber), verifyToJson(record));
}

function withLink(existing: VerifyRecord | null, pull: TrackedPull, linked: Linked): VerifyRecord {
  const base = existing ?? emptyRecord(pull);
  return {
    ...base,
    sentryIssueId: base.sentryIssueId ?? linked.sentryIssueId,
    githubIssueNumber: base.githubIssueNumber ?? linked.githubIssueNumber,
    mergeCommitSha: pull.mergeCommitSha,
    mergedAt: pull.mergedAt,
  };
}

function emptyRecord(pull: TrackedPull): VerifyRecord {
  return {
    prNumber: pull.number,
    phase: "waiting_deploy",
    sentryIssueId: null,
    githubIssueNumber: null,
    mergeCommitSha: pull.mergeCommitSha,
    mergedAt: pull.mergedAt,
    prodSha: null,
    replayMode: null,
    replaySummary: null,
    replayedAt: null,
    agentId: null,
    agentUrl: null,
    startedAt: null,
    failure: null,
  };
}

function failureComment(record: VerifyRecord): string {
  return [
    `Production verification failed for \`${record.mergeCommitSha}\`.`,
    record.failure ?? "Verification failed.",
    record.sentryIssueId === null
      ? "Sentry issue was not resolved."
      : `Sentry issue ${record.sentryIssueId} was not resolved.`,
  ].join("\n");
}

function successComment(record: VerifyRecord): string {
  return [
    "Production verification passed.",
    `Production SHA: \`${record.prodSha ?? ""}\``,
    `Replay: ${record.replayMode ?? "unknown"} — ${record.replaySummary ?? ""}`,
    "New production Sentry events: 0",
    `Sentry issue ${record.sentryIssueId ?? ""} resolved.`,
  ].join("\n");
}

function parseBrowserResult(result: string | undefined): { passed: boolean; summary: string } | null {
  if (result === undefined) {
    return null;
  }
  const start = result.indexOf("{");
  const end = result.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(result.slice(start, end + 1));
    if (!isRecord(value) || typeof value.passed !== "boolean") {
      return null;
    }
    return { passed: value.passed, summary: typeof value.summary === "string" ? value.summary.slice(0, 500) : "" };
  } catch {
    return null;
  }
}

function isTrackedPull(pull: ClosedPull): pull is TrackedPull {
  if (!pull.merged || pull.mergedAt === null || pull.mergeCommitSha === null) {
    return false;
  }
  if (!SHA.test(pull.mergeCommitSha) || Number.isNaN(Date.parse(pull.mergedAt))) {
    return false;
  }
  if (pull.baseRef !== "main" || pull.headRepoFullName !== GITHUB_FULL_NAME) {
    return false;
  }
  return isRepro(pull);
}

function isRepro(pull: ClosedPull): boolean {
  if (pull.labels.includes(REPRO_LABEL)) {
    return true;
  }
  return refsIssueNumber(pull.body) !== null || refsIssueNumber(pull.title) !== null;
}

function isStale(pull: TrackedPull, existing: VerifyRecord | null, now: number): boolean {
  if (now - Date.parse(pull.mergedAt) <= STALE_MS) {
    return false;
  }
  if (existing === null) {
    return true;
  }
  return existing.phase === "resolved" || existing.phase === "failed";
}

function isPhase(value: string | null): value is VerifyPhase {
  switch (value) {
    case "waiting_deploy":
    case "verifying_browser":
    case "replayed":
    case "resolved":
    case "failed":
      return true;
    default:
      return false;
  }
}

function verifyToJson(record: VerifyRecord): JsonObject {
  return {
    prNumber: record.prNumber,
    phase: record.phase,
    sentryIssueId: record.sentryIssueId,
    githubIssueNumber: record.githubIssueNumber,
    mergeCommitSha: record.mergeCommitSha,
    mergedAt: record.mergedAt,
    prodSha: record.prodSha,
    replayMode: record.replayMode,
    replaySummary: record.replaySummary,
    replayedAt: record.replayedAt,
    agentId: record.agentId,
    agentUrl: record.agentUrl,
    startedAt: record.startedAt,
    failure: record.failure,
  };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
