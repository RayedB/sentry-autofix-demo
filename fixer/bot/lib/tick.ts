import type { JsonValue } from "@grok/agent-sdk";
import { classifyCi, failingCheckText } from "./ci.js";
import { isStopped } from "./cloud-status.js";
import { isProtectedPath } from "./paths.js";
import { checkPreview } from "./preview.js";
import { parseFixRecord, runKey, toJson, type FixRecord } from "./record.js";
import { isReproPull } from "./repro.js";

export const MAX_ATTEMPTS = 3;
const PENDING_LIMIT_MS = 30 * 60 * 1000;
const BASE_REF = "main";

export type OpenPull = {
  number: number;
  sha: string;
  ref: string;
  repoFullName: string;
  labels: string[];
  htmlUrl: string;
  merged: boolean;
};

/** One file from `repos.compareCommitsWithBasehead`. `sha` is the blob at the head. */
export type ComparedFile = {
  path: string;
  sha: string | null;
  status: string;
};

export type GitHub = {
  listCheckRuns(sha: string): Promise<unknown>;
  listStatuses(sha: string): Promise<unknown>;
  compareFiles(base: string, head: string): Promise<ComparedFile[]>;
  comment(number: number, body: string): Promise<void>;
  merge(number: number, sha: string): Promise<void>;
  getPull(number: number): Promise<OpenPull>;
};

export type AgentStatus = { status: string };

export type LaunchInput = {
  prNumber: number;
  attempt: number;
  headSha: string;
  prUrl: string;
  failure: string | null;
};

export type TickDeps = {
  kv: {
    get(key: string): Promise<JsonValue | undefined>;
    put(key: string, value: JsonValue): Promise<void>;
  };
  github: GitHub;
  getAgent(agentId: string): Promise<AgentStatus>;
  launch(input: LaunchInput): Promise<{ agentId: string }>;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** One pass over one open pull request. At most one kv write. */
export async function tick(deps: TickDeps, pull: OpenPull): Promise<void> {
  const existing = parseFixRecord(await deps.kv.get(runKey(pull.number)));
  if (existing?.phase === "merged" || existing?.phase === "stopped") {
    return;
  }
  if (!isReproPull({ repoFullName: pull.repoFullName, ref: pull.ref, labels: pull.labels })) {
    return;
  }
  if (existing?.agentId) {
    const agent = await deps.getAgent(existing.agentId);
    if (!isStopped(agent.status)) {
      return;
    }
  }

  const [checkRuns, statuses] = await Promise.all([
    deps.github.listCheckRuns(pull.sha),
    deps.github.listStatuses(pull.sha),
  ]);
  const ci = classifyCi(checkRuns, statuses);
  if (ci === "pending") {
    return;
  }

  const record = existing ?? emptyRecord(pull);
  if (ci === "success") {
    const preview = await checkPreview({ branch: pull.ref, headSha: pull.sha, fetchImpl: deps.fetchImpl });
    if (preview.kind === "pending") {
      await holdPending(deps, record, pull, preview.reason);
      return;
    }
    if (preview.kind === "ok") {
      if (record.attempts < 1) {
        return;
      }
      const tampered = await changedProtectedFiles(deps.github, record.reproSha, pull.sha);
      if (tampered.length > 0) {
        await stop(deps, record, pull, `Protected files changed: ${tampered.join(", ")}`);
        return;
      }
      const merged = await squashMerge(deps, pull, record);
      if (merged) {
        await save(deps, { ...record, phase: "merged", lastFailure: null, pendingSince: null });
        await deps.github.comment(pull.number, `Squash merged \`${pull.sha}\`. CI is green and the preview quote passed.`);
      }
      return;
    }
    await failAttempt(deps, record, pull, preview.reason);
    return;
  }

  const unchanged = existing?.attemptSha !== null && existing?.attemptSha === pull.sha;
  const detail = failingCheckText(checkRuns);
  const reason = unchanged ? joinReason("Cloud agent finished without a new commit.", detail) : joinReason("CI failed.", detail);
  await failAttempt(deps, record, pull, reason);
}

async function holdPending(deps: TickDeps, record: FixRecord, pull: OpenPull, reason: string): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const since = record.pendingSince?.sha === pull.sha ? record.pendingSince : { sha: pull.sha, at: new Date(now).toISOString() };
  if (record.pendingSince?.sha === pull.sha && now - Date.parse(record.pendingSince.at) > PENDING_LIMIT_MS) {
    await stop(deps, { ...record, pendingSince: since }, pull, reason);
    return;
  }
  await save(deps, { ...record, pendingSince: since, lastFailure: reason });
}

async function failAttempt(deps: TickDeps, record: FixRecord, pull: OpenPull, reason: string): Promise<void> {
  if (record.attempts >= MAX_ATTEMPTS) {
    await stop(deps, record, pull, reason);
    return;
  }
  const attempt = record.attempts + 1;
  const launched = await deps.launch({
    prNumber: pull.number,
    attempt,
    headSha: pull.sha,
    prUrl: pull.htmlUrl,
    failure: reason,
  });
  await save(deps, {
    ...record,
    attempts: attempt,
    agentId: launched.agentId,
    attemptSha: pull.sha,
    lastFailure: reason,
    pendingSince: null,
    phase: "active",
  });
}

async function stop(deps: TickDeps, record: FixRecord, pull: OpenPull, reason: string): Promise<void> {
  const stopped = { ...record, phase: "stopped" as const, lastFailure: reason };
  await save(deps, stopped);
  await deps.github.comment(pull.number, stopComment(stopped));
}

async function squashMerge(deps: TickDeps, pull: OpenPull, record: FixRecord): Promise<boolean> {
  try {
    await deps.github.merge(pull.number, pull.sha);
    return true;
  } catch (error) {
    const again = await deps.github.getPull(pull.number);
    if (again.merged) {
      return true;
    }
    const status = errorStatus(error);
    if (again.sha !== pull.sha || status === 409 || status === 405) {
      return false;
    }
    await stop(deps, record, pull, "Squash merge failed.");
    return false;
  }
}

/** Protected blobs on `main...head` must match `main...reproSha`. Catching up to main is allowed. */
async function changedProtectedFiles(github: GitHub, reproSha: string, head: string): Promise<string[]> {
  const [reproFiles, headFiles] = await Promise.all([
    github.compareFiles(BASE_REF, reproSha),
    github.compareFiles(BASE_REF, head),
  ]);
  const repro = keptProtected(reproFiles);
  const next = keptProtected(headFiles);
  const bad = new Set<string>();
  for (const [path, file] of repro) {
    if (file.status !== "added") {
      continue;
    }
    const atHead = next.get(path);
    if (atHead === undefined || atHead.sha !== file.sha) {
      bad.add(path);
    }
  }
  for (const [path, file] of next) {
    const atRepro = repro.get(path);
    if (atRepro === undefined || atRepro.sha !== file.sha) {
      bad.add(path);
    }
  }
  return [...bad];
}

function keptProtected(files: ComparedFile[]): Map<string, ComparedFile> {
  const kept = new Map<string, ComparedFile>();
  for (const file of files) {
    if (file.status === "removed" || file.sha === null || !isProtectedPath(file.path)) {
      continue;
    }
    kept.set(file.path, file);
  }
  return kept;
}

function emptyRecord(pull: OpenPull): FixRecord {
  return {
    prNumber: pull.number,
    reproSha: pull.sha,
    attempts: 0,
    agentId: null,
    attemptSha: null,
    lastFailure: null,
    pendingSince: null,
    phase: "active",
  };
}

function stopComment(record: FixRecord): string {
  return [`Fixer stopped after ${record.attempts} attempts.`, "", record.lastFailure ?? "No failure detail was recorded."].join("\n");
}

function joinReason(lead: string, detail: string): string {
  return detail === "" ? lead : `${lead}\n${detail}`;
}

function errorStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return null;
}

async function save(deps: TickDeps, record: FixRecord): Promise<void> {
  await deps.kv.put(runKey(record.prNumber), toJson(record));
}
