import { githubChannel, type GitHubEventContext, type GitHubStatusEvent } from "@grok/agent-sdk/channels/github";
import { deploymentSha } from "../lib/preview.js";
import { GITHUB_FULL_NAME } from "../lib/github.js";
import { syncBySha, syncNumber } from "../lib/host-sync.js";
import { isReproRef, REPRO_MARKER } from "../lib/repro.js";
import { getCallTool, setCallTool, type ToolCaller } from "../lib/runtime.js";

// Squash merge creates a commit. The documented `pr-write` tier has no
// `contents:write`; `contents-write` is the tier that can push and merge.
const WEBHOOK_EVENTS = [
  "pull_request",
  "check_suite",
  "status",
  "deployment",
  "deployment_status",
] as const;

export default githubChannel({
  botName: "fixer",
  // status, deployment, and deployment_status are outside the pull-request
  // continuation set. These hooks return tasks, so there is no session to resume.
  continuation: "github.none/v2",
  cursorAccount: {
    repos: [GITHUB_FULL_NAME],
    permissions: "contents-write",
  },
  // `deployment` and `deployment_status` have no typed hook. Pinning
  // webhookEvents subscribes to them so `onEvent` can see the preview URL.
  webhookEvents: WEBHOOK_EVENTS,
  progress: { reactions: false },
  deliverReplies: false,
  onStart: (args) => {
    setCallTool((name, input) => args.callTool(name, input));
  },
  onComment: () => null,
  onPullRequest: (ctx, pr) => {
    if (pr.action !== "opened" && pr.action !== "synchronize" && pr.action !== "reopened" && pr.action !== "ready_for_review" && pr.action !== "closed" && pr.action !== "labeled") {
      return null;
    }
    const labeled = pr.label?.name === REPRO_MARKER;
    const marked = isReproRef(pr.headRef) || (pr.body ?? "").includes(REPRO_MARKER) || labeled;
    if (!marked && pr.action !== "closed") {
      return null;
    }
    return { task: () => syncFrom(ctx, pr.number) };
  },
  onCheckSuite: (ctx, suite) => {
    if (suite.action !== "completed") {
      return null;
    }
    const number = suite.pullRequests[0]?.number;
    if (number === undefined) {
      return null;
    }
    return { task: () => syncFrom(ctx, number) };
  },
  onStatus: (ctx, status) => {
    if (!isVercelStatus(status)) {
      return null;
    }
    return { task: () => syncStatus(ctx, status) };
  },
  onEvent: (ctx, event) => {
    if (event.eventName !== "deployment" && event.eventName !== "deployment_status") {
      return null;
    }
    const sha = deploymentSha(event.payload);
    if (sha === null) {
      return null;
    }
    return { task: () => syncDeployment(ctx, sha) };
  },
});

function caller(): ToolCaller {
  return getCallTool();
}

async function syncFrom(ctx: GitHubEventContext, number: number): Promise<void> {
  await syncNumber({
    getOctokit: () => ctx.host.github.getOctokit(),
    kv: ctx.host.kv,
    callTool: caller(),
    number,
  });
}

async function syncStatus(ctx: GitHubEventContext, status: GitHubStatusEvent): Promise<void> {
  const input = {
    getOctokit: () => ctx.host.github.getOctokit(),
    kv: ctx.host.kv,
    callTool: caller(),
  };
  if (ctx.conversation.number > 0) {
    await syncNumber({ ...input, number: ctx.conversation.number });
    return;
  }
  await syncBySha({ ...input, sha: status.sha });
}

async function syncDeployment(ctx: GitHubEventContext, sha: string): Promise<void> {
  await syncBySha({
    getOctokit: () => ctx.host.github.getOctokit(),
    kv: ctx.host.kv,
    callTool: caller(),
    sha,
  });
}

function isVercelStatus(status: GitHubStatusEvent): boolean {
  if (/vercel/i.test(status.context)) {
    return true;
  }
  return (status.targetUrl ?? "").includes(".vercel.app");
}
