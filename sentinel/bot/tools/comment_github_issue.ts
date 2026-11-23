import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { GITHUB_OWNER, GITHUB_REPO, isEvalSession } from "../lib/github.js";

const inputSchema = z.object({
  issueNumber: z.number().int().positive().describe("GitHub issue number returned by create_github_issue"),
  prUrl: z.string().url().describe("Pull request URL from the cloud agent's final JSON"),
  testPath: z.string().optional().describe("Test path from the cloud agent's final JSON"),
  reproduced: z.boolean().optional().describe("Whether the cloud agent reproduced the bug"),
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

    const octokit = await ctx.host.github.getOctokit();
    await octokit.rest.issues.createComment({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      issue_number: input.issueNumber,
      body: lines.join("\n"),
    });
    return {
      commented: true,
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      issueNumber: input.issueNumber,
      prUrl: input.prUrl,
    };
  },
});
