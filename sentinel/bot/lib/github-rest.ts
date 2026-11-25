import { GITHUB_OWNER, GITHUB_REPO } from "./github.js";
import { isRecord, readNumber, readString } from "./json.js";
import type { ClosedPull, VerifyGitHub } from "./verify.js";

type Params = Record<string, string | number>;
type RestCall = (params: Params) => Promise<{ data: unknown }>;

type Rest = {
  pulls: { list: RestCall };
  repos: { compareCommitsWithBasehead: RestCall };
  issues: { createComment: RestCall; get: RestCall; update: RestCall };
};

export function githubFromOctokit(octokit: unknown): VerifyGitHub & { listRecentClosedPulls(): Promise<ClosedPull[]> } {
  const rest = asRest(octokit);
  return {
    listRecentClosedPulls: () => listRecentClosed(rest),
    compareStatus: async (base, head) => {
      const { data } = await rest.repos.compareCommitsWithBasehead({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        basehead: `${base}...${head}`,
      });
      return isRecord(data) ? readString(data, "status") : null;
    },
    comment: async (number, body) => {
      await rest.issues.createComment({ owner: GITHUB_OWNER, repo: GITHUB_REPO, issue_number: number, body });
    },
    getIssue: async (number) => {
      const { data } = await rest.issues.get({ owner: GITHUB_OWNER, repo: GITHUB_REPO, issue_number: number });
      if (!isRecord(data)) {
        return null;
      }
      return {
        body: typeof data.body === "string" ? data.body : null,
        state: readString(data, "state") ?? "open",
      };
    },
    closeIssue: async (number) => {
      await rest.issues.update({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        issue_number: number,
        state: "closed",
        state_reason: "completed",
      });
    },
  };
}

async function listRecentClosed(rest: Rest): Promise<ClosedPull[]> {
  const { data } = await rest.pulls.list({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    state: "closed",
    base: "main",
    sort: "updated",
    direction: "desc",
    per_page: 20,
  });
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((item) => {
    const pull = closedPullFrom(item);
    return pull === null ? [] : [pull];
  });
}

function closedPullFrom(value: unknown): ClosedPull | null {
  if (!isRecord(value)) {
    return null;
  }
  const number = readNumber(value, "number");
  const base = isRecord(value.base) ? readString(value.base, "ref") : null;
  const url = readString(value, "html_url");
  if (number === null || !Number.isInteger(number) || base === null || url === null) {
    return null;
  }
  const head = isRecord(value.head) ? value.head : null;
  const repo = head !== null && isRecord(head.repo) ? readString(head.repo, "full_name") : null;
  const headRef = head === null ? null : readString(head, "ref");
  const mergedAt = readString(value, "merged_at");
  const labels = Array.isArray(value.labels)
    ? value.labels.flatMap((label) => {
        if (!isRecord(label)) {
          return [];
        }
        const name = readString(label, "name");
        return name === null ? [] : [name];
      })
    : [];
  return {
    number,
    merged: mergedAt !== null || value.merged === true,
    mergedAt,
    mergeCommitSha: readString(value, "merge_commit_sha"),
    baseRef: base,
    headRepoFullName: repo,
    labels,
    body: typeof value.body === "string" ? value.body : null,
    title: readString(value, "title") ?? "",
    htmlUrl: url,
    headRef,
  };
}

function asRest(octokit: unknown): Rest {
  if (!isRecord(octokit) || !isRecord(octokit.rest)) {
    throw new Error("GitHub client is unavailable.");
  }
  return octokit.rest as Rest;
}
