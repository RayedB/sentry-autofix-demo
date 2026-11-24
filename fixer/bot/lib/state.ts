import { decideAttempt, MAX_FIX_ATTEMPTS } from "./attempts.js";
import { isRecord, readNumber, readString } from "./json.js";

export const MAX_DETAIL = 5000;
export const LAUNCH_FAILURE_LIMIT = 3;

export type CiState = "pending" | "success" | "failure";
export type PreviewState = "none" | "pending" | "success" | "failure" | "blocked";
export type FixPhase = "launching" | "verifying" | "merged" | "stopped";

export type FixRecord = {
  prNumber: number;
  branch: string;
  attempts: number;
  launchFailures: number;
  phase: FixPhase;
  sourceSha: string;
  verifySha: string | null;
  previewUrl: string | null;
  previewOk: boolean | null;
  ci: CiState;
  failure: string | null;
  cloudAgentId: string | null;
};

export type View = {
  repro: boolean;
  prNumber: number;
  branch: string;
  sha: string;
  ci: CiState;
  previewState: PreviewState;
  previewUrl: string | null;
  previewOk: boolean | null;
  detail: string;
};

export type Step =
  | { type: "ignore" }
  | { type: "probe"; url: string; record: FixRecord }
  | { type: "launch"; record: FixRecord }
  | { type: "wait"; record: FixRecord }
  | { type: "merge"; record: FixRecord }
  | { type: "stop"; record: FixRecord };

export function runKey(prNumber: number): string {
  return `fixer:run:${prNumber}`;
}

export function decide(record: FixRecord | null, view: View): Step {
  if (!view.repro || view.sha.trim() === "") {
    return { type: "ignore" };
  }
  if (record?.phase === "merged" || record?.phase === "stopped") {
    return { type: "ignore" };
  }
  if (record !== null && record.phase === "launching" && record.attempts > 0 && record.sourceSha === view.sha) {
    if (record.cloudAgentId !== null) {
      if (view.ci !== "success") {
        return { type: "ignore" };
      }
    } else if (record.launchFailures >= LAUNCH_FAILURE_LIMIT) {
      return {
        type: "stop",
        record: {
          ...record,
          phase: "stopped",
          failure: record.failure ?? "The cloud agent launch failed.",
        },
      };
    } else {
      return { type: "launch", record };
    }
  }
  if (record === null && view.ci !== "failure") {
    return { type: "ignore" };
  }

  const current = tracking(record, view);
  const previewOk = view.previewState === "failure" ? false : view.previewOk;
  if (view.previewState === "success" && view.previewUrl !== null && previewOk === null) {
    return { type: "probe", url: view.previewUrl, record: current };
  }

  const next = applyView(current, view, previewOk);
  if (view.previewState === "blocked" && next.ci === "success") {
    return {
      type: "stop",
      record: {
        ...next,
        phase: "stopped",
        failure:
          view.detail.trim() === ""
            ? "Vercel Authentication blocked the preview POST. Set VERCEL_AUTOMATION_BYPASS_SECRET."
            : clip(view.detail),
      },
    };
  }
  if (next.ci === "failure" || next.previewOk === false) {
    return launchOrStop(next, view);
  }
  if (next.ci === "success" && next.previewOk === true) {
    return { type: "merge", record: { ...next, phase: "merged" } };
  }
  if (record === null) {
    return { type: "ignore" };
  }
  return { type: "wait", record: { ...next, phase: "verifying", verifySha: view.sha } };
}

export function clip(text: string, max = MAX_DETAIL): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}\n…`;
}

export function parseFixRecord(value: unknown): FixRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const prNumber = readNumber(value, "prNumber");
  const branch = readString(value, "branch");
  const attempts = readNumber(value, "attempts");
  const phase = readString(value, "phase");
  const sourceSha = readString(value, "sourceSha");
  const ci = readString(value, "ci");
  if (
    prNumber === null ||
    !Number.isInteger(prNumber) ||
    branch === null ||
    attempts === null ||
    !Number.isInteger(attempts) ||
    sourceSha === null ||
    !isPhase(phase) ||
    !isCi(ci)
  ) {
    return null;
  }
  const launchFailures = readNumber(value, "launchFailures");
  return {
    prNumber,
    branch,
    attempts,
    launchFailures: launchFailures !== null && Number.isInteger(launchFailures) && launchFailures >= 0 ? launchFailures : 0,
    phase,
    sourceSha,
    verifySha: readString(value, "verifySha"),
    previewUrl: readString(value, "previewUrl"),
    previewOk: typeof value.previewOk === "boolean" ? value.previewOk : null,
    ci,
    failure: typeof value.failure === "string" ? value.failure : null,
    cloudAgentId: readString(value, "cloudAgentId"),
  };
}

export function stopComment(record: FixRecord): string {
  const noun = record.attempts === 1 ? "attempt" : "attempts";
  const failure = record.failure ?? "No failure detail was recorded.";
  return [
    `Fixer stopped after ${record.attempts} ${noun} (limit ${MAX_FIX_ATTEMPTS}).`,
    "",
    "Test files were left unchanged.",
    "",
    "Last failure:",
    clip(failure, 3500),
  ].join("\n");
}

export function mergeComment(sha: string): string {
  return [
    "Squash merged.",
    "",
    `CI is green and POST /api/quote on the Vercel preview returned 200 with a delivery label and a numeric delivery for head \`${sha}\`.`,
  ].join("\n");
}

function tracking(record: FixRecord | null, view: View): FixRecord {
  if (record === null) {
    return {
      prNumber: view.prNumber,
      branch: view.branch,
      attempts: 0,
      launchFailures: 0,
      phase: "verifying",
      sourceSha: "",
      verifySha: view.sha,
      previewUrl: null,
      previewOk: null,
      ci: "pending",
      failure: null,
      cloudAgentId: null,
    };
  }
  if (record.phase === "launching" && record.sourceSha !== "" && record.sourceSha !== view.sha) {
    return {
      ...record,
      branch: view.branch,
      phase: "verifying",
      verifySha: view.sha,
      previewUrl: null,
      previewOk: null,
      ci: "pending",
    };
  }
  return { ...record, branch: view.branch, verifySha: view.sha };
}

function applyView(record: FixRecord, view: View, previewOk: boolean | null): FixRecord {
  return {
    ...record,
    ci: view.ci,
    previewUrl: view.previewUrl,
    previewOk,
    failure: view.detail.trim() === "" ? record.failure : clip(view.detail),
  };
}

function launchOrStop(record: FixRecord, view: View): Step {
  const decision = decideAttempt(record.attempts);
  const failure = view.detail.trim() === "" ? record.failure : clip(view.detail);
  if (decision.action === "stop") {
    return {
      type: "stop",
      record: {
        ...record,
        phase: "stopped",
        verifySha: view.sha,
        branch: view.branch,
        failure,
      },
    };
  }
  return {
    type: "launch",
    record: {
      ...record,
      attempts: decision.attempt,
      launchFailures: 0,
      phase: "launching",
      sourceSha: view.sha,
      verifySha: null,
      branch: view.branch,
      previewUrl: view.previewUrl,
      previewOk: view.previewState === "failure" ? false : view.previewOk,
      ci: view.ci,
      failure,
      cloudAgentId: null,
    },
  };
}

function isPhase(value: string | null): value is FixPhase {
  return value === "launching" || value === "verifying" || value === "merged" || value === "stopped";
}

function isCi(value: string | null): value is CiState {
  return value === "pending" || value === "success" || value === "failure";
}
