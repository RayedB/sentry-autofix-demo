import { GITHUB_OWNER, GITHUB_REPO } from "./github.js";
import { isRecord, readNumber, readString } from "./json.js";
import {
  choosePreview,
  previewFromCommitStatus,
  previewFromParts,
  resolvePreviewUrl,
  type PreviewHit,
} from "./preview.js";
import { failingCheckDetail, summarizeChecks, type CheckRunSnapshot, type CommitStatusSnapshot } from "./checks.js";
import type { Observation, PullInfo } from "./sync.js";

const OWNER = GITHUB_OWNER;
const REPO = GITHUB_REPO;

type Params = Record<string, string | number | boolean>;

type RestCall = (params: Params) => Promise<{ data: unknown }>;

type GitHubRest = {
  pulls: { get: RestCall; list: RestCall; merge: RestCall };
  issues: { createComment: RestCall };
  checks: { listForRef: RestCall; listAnnotations: RestCall };
  repos: { listCommitStatusesForRef: RestCall; listDeployments: RestCall; listDeploymentStatuses: RestCall };
  actions: { downloadJobLogsForWorkflowRun: RestCall };
};

export type RepoClient = {
  getPull(number: number): Promise<PullInfo | null>;
  listOpenPulls(): Promise<PullInfo[]>;
  observe(pull: PullInfo): Promise<Observation>;
  comment(number: number, body: string): Promise<void>;
  squashMerge(number: number, sha: string): Promise<void>;
};

export async function clientFrom(getOctokit: () => Promise<unknown>): Promise<RepoClient> {
  const rest = asRest(await getOctokit());
  return {
    getPull: (number) => readPull(rest, number),
    listOpenPulls: () => listOpen(rest),
    observe: (pull) => observe(rest, pull),
    async comment(number, body) {
      await rest.issues.createComment({
        owner: OWNER,
        repo: REPO,
        issue_number: number,
        body,
      });
    },
    async squashMerge(number, sha) {
      await rest.pulls.merge({
        owner: OWNER,
        repo: REPO,
        pull_number: number,
        merge_method: "squash",
        sha,
        commit_title: `Fix repro #${number}`,
      });
    },
  };
}

async function readPull(rest: GitHubRest, number: number): Promise<PullInfo | null> {
  try {
    const { data } = await rest.pulls.get({ owner: OWNER, repo: REPO, pull_number: number });
    return pullFrom(data);
  } catch (error) {
    if (errorStatus(error) === 404) {
      return null;
    }
    throw error;
  }
}

async function listOpen(rest: GitHubRest): Promise<PullInfo[]> {
  const { data } = await rest.pulls.list({ owner: OWNER, repo: REPO, state: "open", per_page: 30 });
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((item) => {
    const pull = pullFrom(item);
    return pull === null ? [] : [pull];
  });
}

async function observe(rest: GitHubRest, pull: PullInfo): Promise<Observation> {
  const [runs, statuses, preview] = await Promise.all([
    checkRuns(rest, pull.sha),
    commitStatuses(rest, pull.sha),
    previewFor(rest, pull),
  ]);
  const ci = summarizeChecks({ checkRuns: runs, statuses });
  const logs = ci === "failure" ? await failureLogs(rest, pull.sha, runs) : "";
  const summary = failingCheckDetail(runs);
  const detail = [summary, logs].filter((part) => part.trim() !== "").join("\n\n");
  return {
    ci,
    previewState: preview?.state ?? "none",
    previewUrl: preview === null ? null : resolvePreviewUrl(preview, pull.branch),
    detail,
  };
}

async function checkRuns(rest: GitHubRest, sha: string): Promise<CheckRunSnapshot[]> {
  const { data } = await rest.checks.listForRef({
    owner: OWNER,
    repo: REPO,
    ref: sha,
    per_page: 100,
    filter: "latest",
  });
  if (!isRecord(data) || !Array.isArray(data.check_runs)) {
    return [];
  }
  return data.check_runs.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const name = readString(item, "name") ?? "check";
    const status = readString(item, "status") ?? "queued";
    const conclusion = readString(item, "conclusion");
    const output = isRecord(item.output) ? item.output : {};
    const summary = [readString(output, "title"), readString(output, "summary"), readString(output, "text")]
      .filter((part): part is string => part !== null)
      .join("\n");
    return [{ name, status, conclusion, summary: clip(summary, 2000) }];
  });
}

async function commitStatuses(rest: GitHubRest, sha: string): Promise<CommitStatusSnapshot[]> {
  const { data } = await rest.repos.listCommitStatusesForRef({
    owner: OWNER,
    repo: REPO,
    ref: sha,
    per_page: 100,
  });
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const context = readString(item, "context");
    const state = readString(item, "state");
    if (context === null || state === null) {
      return [];
    }
    return [{ context, state }];
  });
}

async function previewFor(rest: GitHubRest, pull: PullInfo): Promise<PreviewHit | null> {
  const hits: PreviewHit[] = [];
  const { data } = await rest.repos.listDeployments({ owner: OWNER, repo: REPO, sha: pull.sha, per_page: 10 });
  const deployments = Array.isArray(data) ? data.filter(isRecord).slice(0, 5) : [];
  for (const deployment of deployments) {
    const id = readNumber(deployment, "id");
    const sha = readString(deployment, "sha") ?? pull.sha;
    if (id === null) {
      continue;
    }
    const statuses = await rest.repos.listDeploymentStatuses({
      owner: OWNER,
      repo: REPO,
      deployment_id: id,
      per_page: 10,
    });
    if (!Array.isArray(statuses.data)) {
      continue;
    }
    for (const status of statuses.data.filter(isRecord)) {
      const state = readString(status, "state");
      if (state === null) {
        continue;
      }
      const hit = previewFromParts({
        sha,
        state,
        environment: readString(status, "environment") ?? readString(deployment, "environment"),
        production: deployment.production_environment === true,
        environmentUrl: readString(status, "environment_url"),
        targetUrl: readString(status, "target_url"),
      });
      if (hit !== null) {
        hits.push(hit);
      }
    }
  }
  const statusPayload = await rest.repos.listCommitStatusesForRef({
    owner: OWNER,
    repo: REPO,
    ref: pull.sha,
    per_page: 100,
  });
  if (Array.isArray(statusPayload.data)) {
    for (const status of statusPayload.data.filter(isRecord)) {
      const context = readString(status, "context");
      const state = readString(status, "state");
      if (context === null || state === null) {
        continue;
      }
      const hit = previewFromCommitStatus({
        sha: pull.sha,
        state,
        context,
        targetUrl: readString(status, "target_url"),
      });
      if (hit !== null) {
        hits.push(hit);
      }
    }
  }
  return choosePreview(hits);
}

async function failureLogs(rest: GitHubRest, sha: string, runs: readonly CheckRunSnapshot[]): Promise<string> {
  const { data } = await rest.checks.listForRef({
    owner: OWNER,
    repo: REPO,
    ref: sha,
    per_page: 100,
    filter: "latest",
  });
  if (!isRecord(data) || !Array.isArray(data.check_runs)) {
    return "";
  }
  const failedNames = new Set(runs.filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out").map((run) => run.name));
  const parts: string[] = [];
  for (const item of data.check_runs.filter(isRecord)) {
    const name = readString(item, "name") ?? "";
    if (!failedNames.has(name)) {
      continue;
    }
    const id = readNumber(item, "id");
    if (id !== null) {
      const notes = await annotationText(rest, id);
      if (notes !== "") {
        parts.push(`${name} annotations:\n${notes}`);
      }
    }
    const details = readString(item, "details_url");
    const jobId = details === null ? null : jobIdFrom(details);
    if (jobId === null) {
      continue;
    }
    const log = await jobLogTail(rest, jobId);
    if (log !== "") {
      parts.push(`${name} log:\n${log}`);
    }
  }
  return clip(parts.join("\n\n"), 4000);
}

async function annotationText(rest: GitHubRest, checkRunId: number): Promise<string> {
  try {
    const { data } = await rest.checks.listAnnotations({
      owner: OWNER,
      repo: REPO,
      check_run_id: checkRunId,
      per_page: 20,
    });
    if (!Array.isArray(data)) {
      return "";
    }
    return data
      .flatMap((item) => (isRecord(item) && readString(item, "message") !== null ? [readString(item, "message") as string] : []))
      .join("\n");
  } catch {
    return "";
  }
}

async function jobLogTail(rest: GitHubRest, jobId: number): Promise<string> {
  try {
    const { data } = await rest.actions.downloadJobLogsForWorkflowRun({
      owner: OWNER,
      repo: REPO,
      job_id: jobId,
    });
    const text = typeof data === "string" ? data : "";
    if (text.trim() === "") {
      return "";
    }
    const lines = text.trim().split("\n");
    return lines.slice(-80).join("\n");
  } catch {
    return "";
  }
}

function pullFrom(value: unknown): PullInfo | null {
  if (!isRecord(value) || !isRecord(value.head)) {
    return null;
  }
  const number = readNumber(value, "number");
  const sha = readString(value.head, "sha");
  const branch = readString(value.head, "ref");
  const url = readString(value, "html_url");
  if (number === null || sha === null || branch === null || url === null) {
    return null;
  }
  const labels = Array.isArray(value.labels)
    ? value.labels.flatMap((label) => (isRecord(label) && readString(label, "name") !== null ? [readString(label, "name") as string] : []))
    : [];
  return {
    number,
    url,
    branch,
    sha,
    body: typeof value.body === "string" ? value.body : "",
    labels,
    open: value.state === "open",
    merged: value.merged === true,
  };
}

function jobIdFrom(url: string): number | null {
  const match = /\/job\/(\d+)/.exec(url);
  if (match?.[1] === undefined) {
    return null;
  }
  const id = Number(match[1]);
  return Number.isInteger(id) ? id : null;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}\n…`;
}

function errorStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return null;
}

function asRest(octokit: unknown): GitHubRest {
  if (!isRecord(octokit) || !isRecord(octokit.rest)) {
    throw new Error("GitHub client is unavailable.");
  }
  return octokit.rest as GitHubRest;
}
