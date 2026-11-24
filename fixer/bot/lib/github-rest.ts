import { GITHUB_OWNER, GITHUB_REPO } from "./github.js";
import { isRecord, readNumber, readString } from "./json.js";
import type { GitHub, OpenPull } from "./tick.js";

type Params = Record<string, string | number>;
type RestCall = (params: Params) => Promise<{ data: unknown }>;

type Rest = {
  pulls: { list: RestCall; get: RestCall; merge: RestCall };
  checks: { listForRef: RestCall };
  repos: { listCommitStatusesForRef: RestCall; compareCommitsWithBasehead: RestCall };
  issues: { createComment: RestCall };
};

export function githubFromOctokit(octokit: unknown): GitHub & { listOpenPulls(): Promise<OpenPull[]> } {
  const rest = asRest(octokit);
  return {
    listOpenPulls: () => listOpen(rest),
    listCheckRuns: async (sha) => {
      const { data } = await rest.checks.listForRef({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: sha, per_page: 100 });
      return data;
    },
    listStatuses: async (sha) => {
      const { data } = await rest.repos.listCommitStatusesForRef({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        ref: sha,
        per_page: 100,
      });
      return data;
    },
    compareFiles: (base, head) => compareFiles(rest, base, head),
    comment: async (number, body) => {
      await rest.issues.createComment({ owner: GITHUB_OWNER, repo: GITHUB_REPO, issue_number: number, body });
    },
    merge: async (number, sha) => {
      await rest.pulls.merge({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        pull_number: number,
        merge_method: "squash",
        sha,
        commit_title: `Fix repro #${number}`,
      });
    },
    getPull: (number) => readPull(rest, number),
  };
}

async function listOpen(rest: Rest): Promise<OpenPull[]> {
  const { data } = await rest.pulls.list({ owner: GITHUB_OWNER, repo: GITHUB_REPO, state: "open", per_page: 30 });
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((item) => {
    const pull = pullFrom(item);
    return pull === null ? [] : [pull];
  });
}

async function readPull(rest: Rest, number: number): Promise<OpenPull> {
  const { data } = await rest.pulls.get({ owner: GITHUB_OWNER, repo: GITHUB_REPO, pull_number: number });
  const pull = pullFrom(data);
  if (pull === null) {
    throw new Error(`Pull request #${number} did not include a head.`);
  }
  return pull;
}

async function compareFiles(rest: Rest, base: string, head: string): Promise<string[]> {
  const { data } = await rest.repos.compareCommitsWithBasehead({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    basehead: `${base}...${head}`,
  });
  if (!isRecord(data) || !Array.isArray(data.files)) {
    return [];
  }
  return data.files.flatMap((file) => (isRecord(file) && readString(file, "filename") !== null ? [readString(file, "filename") as string] : []));
}

function pullFrom(value: unknown): OpenPull | null {
  if (!isRecord(value) || !isRecord(value.head)) {
    return null;
  }
  const number = readNumber(value, "number");
  const sha = readString(value.head, "sha");
  const ref = readString(value.head, "ref");
  const url = readString(value, "html_url");
  const repo = isRecord(value.head.repo) ? readString(value.head.repo, "full_name") : null;
  if (number === null || sha === null || ref === null || url === null || repo === null) {
    return null;
  }
  const labels = Array.isArray(value.labels)
    ? value.labels.flatMap((label) => (isRecord(label) && readString(label, "name") !== null ? [readString(label, "name") as string] : []))
    : [];
  return {
    number,
    sha,
    ref,
    repoFullName: repo,
    labels,
    htmlUrl: url,
    merged: value.merged === true,
  };
}

function asRest(octokit: unknown): Rest {
  if (!isRecord(octokit) || !isRecord(octokit.rest)) {
    throw new Error("GitHub client is unavailable.");
  }
  return octokit.rest as Rest;
}
