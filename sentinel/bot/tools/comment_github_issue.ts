import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { GITHUB_OWNER, GITHUB_REPO, isEvalSession } from "../lib/github.js";
import {
  issueLinkKey,
  parseIssueLink,
  prLinkJson,
  prLinkKey,
  prNumberFromUrl,
  sentryIssueIdFromContinuation,
} from "../lib/links.js";
import { isSafeTestPath, parseAgentReplay } from "../lib/replay.js";

const inputSchema = z.object({
  issueNumber: z.number().int().positive().describe("GitHub issue number returned by create_github_issue"),
  prUrl: z.string().url().describe("Pull request URL from the cloud agent's final JSON"),
  testPath: z.string().optional().describe("Test path from the cloud agent's final JSON"),
  reproduced: z.boolean().optional().describe("Whether the cloud agent reproduced the bug"),
  replay: z.unknown().optional().describe("Replay spec from the cloud agent's final JSON, or null"),
});

type CommentGitHubIssueResult = {
  commented: boolean;
  reason?: "eval";
  owner: string;
  repo: string;
  issueNumber: number;
  prUrl: string;
};

export default defineTool({
  description:
    "Comment the repro pull request link on the GitHub issue opened for this Sentry alert. Call once, after cloud__get returns a prUrl. Do not call it on the alert turn.",
  effect: "write",
  inputSchema,
  dryRunResult: ({ issueNumber, prUrl }): CommentGitHubIssueResult => ({
    commented: false,
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    issueNumber,
    prUrl,
  }),
  async execute(input, ctx): Promise<CommentGitHubIssueResult> {
    if (isEvalSession(ctx.session.purpose)) {
      return {
        commented: false,
        reason: "eval",
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        issueNumber: input.issueNumber,
        prUrl: input.prUrl,
      };
    }

    const lines = [`Repro pull request: ${input.prUrl}`];
    if (input.testPath !== undefined) {
      lines.push(`Test: ${input.testPath}`);
    }
    if (input.reproduced !== undefined) {
      lines.push(`Reproduced: ${input.reproduced ? "yes" : "no"}`);
    }

    const prNumber = prNumberFromUrl(input.prUrl);
    if (prNumber === null) {
      throw new Error("prUrl must be a pull request on RayedB/sentry-autofix-demo.");
    }

    const octokit = await ctx.host.github.getOctokit();
    await octokit.rest.issues.createComment({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      issue_number: input.issueNumber,
      body: lines.join("\n"),
    });

    const existing = parseIssueLink(await ctx.host.kv.get(issueLinkKey(input.issueNumber)));
    const sentryIssueId = existing?.sentryIssueId ?? sentryIssueIdFromContinuation(ctx.session.continuationKey);
    const fromAgent = input.replay == null ? null : parseAgentReplay(input.replay);
    const replay = existing?.replay ?? fromAgent ?? null;
    const testPath = input.testPath !== undefined && isSafeTestPath(input.testPath) ? input.testPath : null;
    if (sentryIssueId !== null) {
      await ctx.host.kv.put(
        prLinkKey(prNumber),
        prLinkJson({
          sentryIssueId,
          githubIssueNumber: input.issueNumber,
          prNumber,
          testPath,
          replay,
        }),
      );
    }
    return {
      commented: true,
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      issueNumber: input.issueNumber,
      prUrl: input.prUrl,
    };
  },
});
