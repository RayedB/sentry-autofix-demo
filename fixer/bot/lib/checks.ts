import type { CiState } from "./state.js";

export type CheckRunSnapshot = {
  name: string;
  status: string;
  conclusion: string | null;
  summary: string;
};

export type CommitStatusSnapshot = {
  context: string;
  state: string;
};

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);
const OK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

export function latestByContext(statuses: readonly CommitStatusSnapshot[]): CommitStatusSnapshot[] {
  const seen = new Set<string>();
  const latest: CommitStatusSnapshot[] = [];
  for (const status of statuses) {
    if (seen.has(status.context)) {
      continue;
    }
    seen.add(status.context);
    latest.push(status);
  }
  return latest;
}

/** Aggregate GitHub check runs and commit statuses for one commit. */
export function summarizeChecks(input: {
  checkRuns: readonly CheckRunSnapshot[];
  statuses: readonly CommitStatusSnapshot[];
}): CiState {
  const runs = input.checkRuns;
  const statuses = latestByContext(input.statuses);
  const runFailed = runs.some((run) => run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion));
  const statusFailed = statuses.some((status) => status.state === "failure" || status.state === "error");
  if (runFailed || statusFailed) {
    return "failure";
  }
  if (runs.length === 0) {
    return "pending";
  }
  const runPending = runs.some((run) => !runOk(run));
  const statusPending = statuses.some((status) => status.state === "pending");
  if (runPending || statusPending) {
    return "pending";
  }
  return "success";
}

export function failingCheckDetail(runs: readonly CheckRunSnapshot[]): string {
  const failed = runs.filter((run) => run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion));
  if (failed.length === 0) {
    return "";
  }
  return failed
    .map((run) => {
      const body = run.summary.trim();
      return body === "" ? `${run.name}: ${run.conclusion ?? "failure"}` : `${run.name}: ${run.conclusion ?? "failure"}\n${body}`;
    })
    .join("\n\n");
}

function runOk(run: CheckRunSnapshot): boolean {
  return run.status === "completed" && run.conclusion !== null && OK_CONCLUSIONS.has(run.conclusion);
}
