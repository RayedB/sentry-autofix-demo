import type { JsonValue } from "@grok/agent-sdk";
import { classifyCi } from "./ci.js";
import { isTestPath } from "./paths.js";
import { checkPreview } from "./preview.js";
import { parseFixRecord, runKey, toJson, type FixRecord } from "./record.js";
import { isReproPull } from "./repro.js";

export const MAX_ATTEMPTS = 3;

export type OpenPull = {
  number: number;
  sha: string;
  ref: string;
  repoFullName: string;
  labels: string[];
  htmlUrl: string;
  merged: boolean;
};

export type GitHub = {
  listCheckRuns(sha: string): Promise<unknown>;
  listStatuses(sha: string): Promise<unknown>;
  compareFiles(base: string, head: string): Promise<string[]>;
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
    if (agent.status === "creating" || agent.status === "running") {
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
      return;
    }
    if (preview.kind === "ok") {
      const changed = await changedTestFiles(deps.github, record.reproSha, pull.sha);
      if (changed.length > 0) {
        const stopped = { ...record, phase: "stopped" as const, lastFailure: `Test files changed: ${changed.join(", ")}` };
        await save(deps, stopped);
        await deps.github.comment(pull.number, stopComment(stopped));
        return;
      }
      const merged = await squashMerge(deps, pull, record);
      if (merged) {
        await save(deps, { ...record, phase: "merged", lastFailure: null });
        await deps.github.comment(pull.number, `Squash merged \`${pull.sha}\`. CI is green and the preview quote passed.`);
      }
      return;
    }
    await failAttempt(deps, record, pull, preview.reason);
    return;
  }

  const unchanged = pull.sha === record.reproSha;
  const reason = unchanged && existing?.agentId ? "Cloud agent finished without a new commit." : "CI failed.";
  await failAttempt(deps, record, pull, reason);
}

async function failAttempt(deps: TickDeps, record: FixRecord, pull: OpenPull, reason: string): Promise<void> {
  if (record.attempts >= MAX_ATTEMPTS) {
    const stopped = { ...record, phase: "stopped" as const, lastFailure: reason };
    await save(deps, stopped);
    await deps.github.comment(pull.number, stopComment(stopped));
    return;
  }
  const attempt = record.attempts + 1;
  const next = { ...record, attempts: attempt, lastFailure: reason, phase: "active" as const };
  const launched = await deps.launch({
    prNumber: pull.number,
    attempt,
    headSha: pull.sha,
    prUrl: pull.htmlUrl,
    failure: reason,
  });
  await save(deps, { ...next, agentId: launched.agentId });
}

async function squashMerge(deps: TickDeps, pull: OpenPull, record: FixRecord): Promise<boolean> {
  try {
    await deps.github.merge(pull.number, pull.sha);
    return true;
  } catch {
    const again = await deps.github.getPull(pull.number);
    if (again.merged) {
      return true;
    }
    const stopped = { ...record, phase: "stopped" as const, lastFailure: "Squash merge failed." };
    await save(deps, stopped);
    await deps.github.comment(pull.number, stopComment(stopped));
    return false;
  }
}

async function changedTestFiles(github: GitHub, base: string, head: string): Promise<string[]> {
  if (base === head) {
    return [];
  }
  const files = await github.compareFiles(base, head);
  return files.filter(isTestPath);
}

function emptyRecord(pull: OpenPull): FixRecord {
  return {
    prNumber: pull.number,
    reproSha: pull.sha,
    attempts: 0,
    agentId: null,
    lastFailure: null,
    phase: "active",
  };
}

function stopComment(record: FixRecord): string {
  return [`Fixer stopped after ${record.attempts} attempts.`, "", record.lastFailure ?? "No failure detail was recorded."].join("\n");
}

async function save(deps: TickDeps, record: FixRecord): Promise<void> {
  await deps.kv.put(runKey(record.prNumber), toJson(record));
}
