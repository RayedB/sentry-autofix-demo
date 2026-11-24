import { isReproPull } from "./repro.js";
import {
  clip,
  decide,
  LAUNCH_FAILURE_LIMIT,
  mergeComment,
  parseFixRecord,
  runKey,
  stopComment,
  type FixRecord,
  type Step,
  type View,
} from "./state.js";
import { isPreviewProtection, type QuoteVerdict } from "./preview.js";

export type PullInfo = {
  number: number;
  url: string;
  branch: string;
  sha: string;
  body: string;
  labels: string[];
  open: boolean;
  merged: boolean;
};

export type Observation = {
  ci: View["ci"];
  previewState: View["previewState"];
  previewUrl: string | null;
  detail: string;
};

export type Kv = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
};

export type SyncDeps = {
  kv: Kv;
  probe: (url: string) => Promise<QuoteVerdict>;
  launch: (record: FixRecord) => Promise<void>;
  comment: (prNumber: number, body: string) => Promise<void>;
  merge: (prNumber: number, sha: string) => Promise<void>;
};

export function isShaConflict(error: unknown): boolean {
  return errorStatus(error) === 409;
}

export async function syncPull(deps: SyncDeps, pull: PullInfo, observation: Observation): Promise<void> {
  const existing = await load(deps.kv, pull.number);
  if (!pull.open || pull.merged) {
    if (existing !== null && existing.phase !== "merged" && existing.phase !== "stopped") {
      await save(deps.kv, { ...existing, phase: "stopped" });
    }
    return;
  }
  if (!isReproPull({ ref: pull.branch, body: pull.body, labels: pull.labels })) {
    return;
  }

  const cachedOk = cachedPreview(existing, pull.sha, observation.previewUrl);
  let view = toView(pull, observation, cachedOk);
  let step = decide(existing, view);
  if (step.type === "probe") {
    step = await afterProbe(deps, existing, pull, observation, step);
  }
  await applyStep(deps, pull, step);
}

async function afterProbe(
  deps: SyncDeps,
  existing: FixRecord | null,
  pull: PullInfo,
  observation: Observation,
  step: Extract<Step, { type: "probe" }>,
): Promise<Step> {
  let verdict: QuoteVerdict;
  try {
    verdict = await deps.probe(step.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "preview request failed";
    return {
      type: "wait",
      record: {
        ...step.record,
        phase: "verifying",
        verifySha: pull.sha,
        previewUrl: step.url,
        failure: clip(message),
      },
    };
  }
  if (isPreviewProtection(verdict)) {
    const detail = joinDetail(
      observation.detail,
      "Vercel Authentication blocked POST /api/quote. Set VERCEL_AUTOMATION_BYPASS_SECRET to the project's Protection Bypass for Automation secret.",
    );
    return decide(existing, toView(pull, { ...observation, previewState: "blocked", previewUrl: step.url, detail }, null));
  }
  const detail = verdict.ok ? observation.detail : joinDetail(observation.detail, previewFailure(verdict));
  const next = decide(existing, toView(pull, { ...observation, detail }, verdict.ok));
  if (next.type === "probe") {
    return {
      type: "wait",
      record: {
        ...next.record,
        phase: "verifying",
        verifySha: pull.sha,
        previewUrl: step.url,
        previewOk: verdict.ok,
      },
    };
  }
  return next;
}

async function applyStep(deps: SyncDeps, pull: PullInfo, step: Step): Promise<void> {
  switch (step.type) {
    case "ignore":
    case "probe":
      return;
    case "wait":
      await save(deps.kv, step.record);
      return;
    case "launch":
      await save(deps.kv, step.record);
      try {
        await deps.launch(step.record);
      } catch (error) {
        const failures = step.record.launchFailures + 1;
        const message = error instanceof Error ? error.message : "launch failed";
        const stopped = failures >= LAUNCH_FAILURE_LIMIT;
        await save(deps.kv, {
          ...step.record,
          launchFailures: failures,
          failure: clip(message),
          phase: stopped ? "stopped" : "launching",
        });
        if (stopped) {
          await deps.comment(pull.number, stopComment({ ...step.record, attempts: step.record.attempts, failure: message }));
        }
      }
      return;
    case "merge":
      try {
        await deps.merge(pull.number, pull.sha);
      } catch (error) {
        if (isShaConflict(error)) {
          await save(deps.kv, { ...step.record, phase: "verifying", verifySha: pull.sha });
          return;
        }
        const message = error instanceof Error ? error.message : "merge failed";
        await deps.comment(
          pull.number,
          `Preview and CI passed for \`${pull.sha}\`, and squash merge failed.\n\n${clip(message, 2000)}`,
        );
        await save(deps.kv, { ...step.record, phase: "stopped", failure: message });
        return;
      }
      await save(deps.kv, step.record);
      await deps.comment(pull.number, mergeComment(pull.sha));
      return;
    case "stop":
      await deps.comment(pull.number, stopComment(step.record));
      await save(deps.kv, step.record);
      return;
    default: {
      const unreachable: never = step;
      throw new Error(`Unknown fixer step: ${String(unreachable)}`);
    }
  }
}

function toView(pull: PullInfo, observation: Observation, previewOk: boolean | null): View {
  return {
    repro: true,
    prNumber: pull.number,
    branch: pull.branch,
    sha: pull.sha,
    ci: observation.ci,
    previewState: observation.previewState,
    previewUrl: observation.previewUrl,
    previewOk,
    detail: observation.detail,
  };
}

function cachedPreview(record: FixRecord | null, sha: string, url: string | null): boolean | null {
  if (record === null || url === null || record.verifySha !== sha || record.previewUrl !== url) {
    return null;
  }
  return record.previewOk;
}

function previewFailure(verdict: Extract<QuoteVerdict, { ok: false }>): string {
  return `Preview POST /api/quote returned ${verdict.status}. ${verdict.reason}\n${verdict.body}`;
}

function joinDetail(left: string, right: string): string {
  if (left.trim() === "") {
    return right;
  }
  if (right.trim() === "") {
    return left;
  }
  return `${left.trim()}\n\n${right.trim()}`;
}

async function load(kv: Kv, prNumber: number): Promise<FixRecord | null> {
  return parseFixRecord(await kv.get(runKey(prNumber)));
}

async function save(kv: Kv, record: FixRecord): Promise<void> {
  await kv.put(runKey(record.prNumber), record);
}

function errorStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return null;
}
