import { isRecord, readString } from "./json.js";

export const REQUIRED_CHECKS = ["test", "e2e"] as const;
export const VERCEL_STATUS_CONTEXT = "Vercel";

export type CiState = "success" | "failure" | "pending";

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);

type Run = {
  name: string;
  status: string;
  conclusion: string | null;
  title: string | null;
  summary: string | null;
};
type Status = { context: string; state: string };

/** One `checks.listForRef` body and one `listCommitStatusesForRef` body. */
export function classifyCi(checkRunsPayload: unknown, statusesPayload: unknown): CiState {
  const runs = checkRuns(checkRunsPayload);
  const statuses = latestStatuses(statusesPayload);
  let failed = false;
  let pending = false;
  for (const name of REQUIRED_CHECKS) {
    const run = runs.find((item) => item.name === name);
    if (run === undefined) {
      pending = true;
      continue;
    }
    if (run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) {
      failed = true;
      continue;
    }
    if (run.status !== "completed" || run.conclusion !== "success") {
      pending = true;
    }
  }
  const vercel = statuses.find((status) => status.context === VERCEL_STATUS_CONTEXT);
  if (vercel === undefined) {
    pending = true;
  } else if (vercel.state === "failure" || vercel.state === "error") {
    failed = true;
  } else if (vercel.state !== "success") {
    pending = true;
  }
  if (failed) {
    return "failure";
  }
  if (pending) {
    return "pending";
  }
  return "success";
}

/** Titles and summaries from check runs that failed. */
export function failingCheckText(checkRunsPayload: unknown): string {
  return checkRuns(checkRunsPayload)
    .filter((run) => run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion))
    .map((run) => {
      const detail = [run.title, run.summary].filter((part): part is string => part !== null && part !== "").join("\n");
      return detail === "" ? `${run.name}: ${run.conclusion}` : `${run.name}: ${run.conclusion}\n${detail}`;
    })
    .join("\n\n");
}

function checkRuns(payload: unknown): Run[] {
  const list = isRecord(payload) && Array.isArray(payload.check_runs) ? payload.check_runs : [];
  return list.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const name = readString(item, "name");
    if (name === null) {
      return [];
    }
    const output = isRecord(item.output) ? item.output : {};
    return [
      {
        name,
        status: readString(item, "status") ?? "queued",
        conclusion: readString(item, "conclusion"),
        title: readString(output, "title"),
        summary: readString(output, "summary"),
      },
    ];
  });
}

function latestStatuses(payload: unknown): Status[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const seen = new Set<string>();
  const latest: Status[] = [];
  for (const item of payload) {
    if (!isRecord(item)) {
      continue;
    }
    const context = readString(item, "context");
    const state = readString(item, "state");
    if (context === null || state === null || seen.has(context)) {
      continue;
    }
    seen.add(context);
    latest.push({ context, state });
  }
  return latest;
}
