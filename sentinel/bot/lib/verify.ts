import type { JsonObject, JsonValue } from "@grok/agent-sdk";
import * as z from "zod/v4";
import { isStopped } from "./cloud-status.js";
import { GITHUB_FULL_NAME } from "./github.js";
import { isRecord, readString } from "./json.js";
import { parsePrLink, prLinkKey, refsIssueNumber, sentryIssueIdFromText, type PrLink } from "./links.js";
import { parseAgentReplay, PROD_ORIGIN, replayToJson, runHttpReplay, type ReplaySpec } from "./replay.js";
import { isSentryNotFound } from "./sentry.js";

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
  testPath: string | null;
  replay: ReplaySpec | null;
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
  headRef: string | null;
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

type ReadyLink = {
  kind: "ready";
  sentryIssueId: string;
  githubIssueNumber: number | null;
  testPath: string | null;
  replay: ReplaySpec;
};

type LinkOutcome =
  | ReadyLink
  | { kind: "not-sentry" }
  | { kind: "missing"; sentryIssueId: string; githubIssueNumber: number | null }
  | { kind: "none"; sentryIssueId: string | null; githubIssueNumber: number | null };

const verifyRecordSchema = z.object({
  prNumber: z.number().int().positive(),
  phase: z.enum(["waiting_deploy", "verifying_browser", "replayed", "resolved", "failed"]),
  sentryIssueId: z.string().nullable().optional(),
  githubIssueNumber: z.number().int().positive().nullable().optional(),
  mergeCommitSha: z.string().min(1),
  mergedAt: z.string().min(1),
  prodSha: z.string().nullable().optional(),
  replayMode: z.enum(["http", "browser"]).nullable().optional(),
  replaySummary: z.string().nullable().optional(),
  replayedAt: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  agentUrl: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  failure: z.string().nullable().optional(),
  testPath: z.string().nullable().optional(),
  replay: z.unknown().optional().nullable(),
});

/** One pass over one closed pull request. At most one phase change. No sleep. */
export async function verifyTick(deps: VerifyDeps, pull: ClosedPull): Promise<void> {
  if (!isCandidate(pull)) {
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
  const cached = existing?.replay != null && existing.sentryIssueId != null;
  const prLink = cached ? null : parsePrLink(await deps.kv.get(prLinkKey(pull.number)));
  if (!isReproPull(pull, cached || prLink !== null)) {
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
      await stepWaiting(deps, existing, pull, now, prLink);
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
  const parsed = verifyRecordSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  return {
    prNumber: data.prNumber,
    phase: data.phase,
    sentryIssueId: data.sentryIssueId ?? null,
    githubIssueNumber: data.githubIssueNumber ?? null,
    mergeCommitSha: data.mergeCommitSha,
    mergedAt: data.mergedAt,
    prodSha: data.prodSha ?? null,
    replayMode: data.replayMode ?? null,
    replaySummary: data.replaySummary ?? null,
    replayedAt: data.replayedAt ?? null,
    agentId: data.agentId ?? null,
    agentUrl: data.agentUrl ?? null,
    startedAt: data.startedAt ?? null,
    failure: data.failure ?? null,
    testPath: data.testPath ?? null,
    replay: data.replay == null ? null : parseAgentReplay(data.replay),
  };
}

async function stepWaiting(
  deps: VerifyDeps,
  existing: VerifyRecord | null,
  pull: TrackedPull,
  now: number,
  prefetched: PrLink | null,
): Promise<void> {
  const linked = await linkFor(deps, existing, pull, prefetched);
  if (linked.kind === "not-sentry") {
    return;
  }
  if (linked.kind === "missing") {
    await save(deps, {
      ...withIds(existing, pull, linked.sentryIssueId, linked.githubIssueNumber),
      phase: "failed",
      failure: `Sentry issue ${linked.sentryIssueId} was not found.`,
    });
    return;
  }
  if (linked.kind === "none") {
    const reason =
      linked.sentryIssueId === null
        ? "No Sentry issue id was linked to this pull request."
        : "No safe production replay descriptor was found for this merge.";
    await fail(deps, pull, withIds(existing, pull, linked.sentryIssueId, linked.githubIssueNumber), reason);
    return;
  }
  const record = withLink(existing, pull, linked);
  const prodSha = await readProdSha(deps.fetchImpl ?? fetch);
  if (prodSha === null || !(await deployReady(deps, pull.mergeCommitSha, prodSha))) {
    if (now - Date.parse(pull.mergedAt) > DEPLOY_MS) {
      await fail(deps, pull, { ...record, prodSha }, `Production did not serve merge ${pull.mergeCommitSha} within 30 minutes.`);
      return;
    }
    await save(deps, { ...record, phase: "waiting_deploy", prodSha, failure: null });
    return;
  }
  switch (linked.replay.kind) {
    case "http":
      await replayHttp(deps, pull, record, linked.replay, prodSha, now);
      return;
    case "browser":
      await launchBrowser(deps, pull, record, linked.replay, linked.testPath, prodSha, now);
      return;
    default: {
      const unknown: never = linked.replay;
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
  await save(deps, resolved);
  await commentBoth(deps, pull.number, record.githubIssueNumber, successComment(resolved));
  if (record.githubIssueNumber !== null) {
    const issue = await deps.github.getIssue(record.githubIssueNumber);
    if (issue !== null && issue.state === "open") {
      await deps.github.closeIssue(record.githubIssueNumber);
    }
  }
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

async function linkFor(
  deps: VerifyDeps,
  existing: VerifyRecord | null,
  pull: TrackedPull,
  prefetched: PrLink | null,
): Promise<LinkOutcome> {
  if (existing?.replay != null && existing.sentryIssueId != null) {
    return {
      kind: "ready",
      sentryIssueId: existing.sentryIssueId,
      githubIssueNumber: existing.githubIssueNumber,
      testPath: existing.testPath,
      replay: existing.replay,
    };
  }
  return resolveLink(deps, pull, prefetched);
}

async function resolveLink(deps: VerifyDeps, pull: TrackedPull, stored: PrLink | null): Promise<LinkOutcome> {
  if (stored !== null) {
    return outcomeFromIssue(deps, stored.sentryIssueId, stored.githubIssueNumber, stored.testPath, stored.replay);
  }
  const issueNumber = refsIssueNumber(pull.body) ?? refsIssueNumber(pull.title);
  if (issueNumber === null) {
    return { kind: "none", sentryIssueId: null, githubIssueNumber: null };
  }
  const issue = await deps.github.getIssue(issueNumber);
  const sentryIssueId = sentryIssueIdFromText(issue?.body ?? null);
  if (sentryIssueId === null) {
    return { kind: "not-sentry" };
  }
  return outcomeFromIssue(deps, sentryIssueId, issueNumber, null, null);
}

async function outcomeFromIssue(
  deps: VerifyDeps,
  sentryIssueId: string,
  githubIssueNumber: number | null,
  testPath: string | null,
  replay: ReplaySpec | null,
): Promise<LinkOutcome> {
  if (replay === null) {
    try {
      replay = (await deps.sentry.fetchIssue(sentryIssueId)).replay;
    } catch (error) {
      if (isSentryNotFound(error)) {
        return { kind: "missing", sentryIssueId, githubIssueNumber };
      }
      throw error;
    }
  }
  if (replay === null) {
    return { kind: "none", sentryIssueId, githubIssueNumber };
  }
  return { kind: "ready", sentryIssueId, githubIssueNumber, testPath, replay };
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

function withLink(existing: VerifyRecord | null, pull: TrackedPull, linked: ReadyLink): VerifyRecord {
  const base = existing ?? emptyRecord(pull);
  return {
    ...base,
    sentryIssueId: linked.sentryIssueId,
    githubIssueNumber: linked.githubIssueNumber ?? base.githubIssueNumber,
    testPath: linked.testPath ?? base.testPath,
    replay: linked.replay,
    mergeCommitSha: pull.mergeCommitSha,
    mergedAt: pull.mergedAt,
  };
}

function withIds(
  existing: VerifyRecord | null,
  pull: TrackedPull,
  sentryIssueId: string | null,
  githubIssueNumber: number | null,
): VerifyRecord {
  const base = existing ?? emptyRecord(pull);
  return {
    ...base,
    sentryIssueId: sentryIssueId ?? base.sentryIssueId,
    githubIssueNumber: githubIssueNumber ?? base.githubIssueNumber,
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
    testPath: null,
    replay: null,
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

export function parseBrowserResult(result: string | undefined): { passed: boolean; summary: string } | null {
  if (result === undefined) {
    return null;
  }
  const text = result.trim();
  for (let end = text.length; end > 0; end -= 1) {
    if (text[end - 1] !== "}") {
      continue;
    }
    for (let start = end - 1; start >= 0; start -= 1) {
      if (text[start] !== "{") {
        continue;
      }
      const parsed = browserVerdict(text.slice(start, end));
      if (parsed !== null) {
        return parsed;
      }
    }
  }
  return null;
}

function browserVerdict(candidate: string): { passed: boolean; summary: string } | null {
  try {
    const value: unknown = JSON.parse(candidate);
    if (!isRecord(value) || typeof value.passed !== "boolean") {
      return null;
    }
    return { passed: value.passed, summary: typeof value.summary === "string" ? value.summary.slice(0, 500) : "" };
  } catch {
    return null;
  }
}

function isCandidate(pull: ClosedPull): pull is TrackedPull {
  if (!pull.merged || pull.mergedAt === null || pull.mergeCommitSha === null) {
    return false;
  }
  if (!SHA.test(pull.mergeCommitSha) || Number.isNaN(Date.parse(pull.mergedAt))) {
    return false;
  }
  if (pull.baseRef !== "main" || pull.headRepoFullName !== GITHUB_FULL_NAME) {
    return false;
  }
  return true;
}

function isReproPull(pull: ClosedPull, linked: boolean): boolean {
  if (pull.labels.includes(REPRO_LABEL) || linked) {
    return true;
  }
  const ref = pull.headRef ?? "";
  return ref.startsWith("repro/") || ref.startsWith("cursor/repro-");
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
    testPath: record.testPath,
    replay: record.replay === null ? null : replayToJson(record.replay),
  };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
