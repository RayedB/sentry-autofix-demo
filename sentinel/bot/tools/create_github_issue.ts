import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { GITHUB_OWNER, GITHUB_REPO, isEvalSession } from "../lib/github.js";
import { issueLinkJson, issueLinkKey, parseSentryIssueMemory, sentryIssueIdFromContinuation, sentryIssueKey } from "../lib/links.js";

const inputSchema = z.object({
  title: z.string().min(1).describe("Sentry issue title"),
  sentryUrl: z.string().min(1).describe("Sentry web_url for the event or issue"),
  stackSummary: z.string().min(1).describe("Short exception and in-app stack summary"),
  suspectedFile: z.string().min(1).describe("Suspected in-app filename"),
  suspectedLine: z.number().int().positive().describe("Suspected line number"),
  reproHint: z.string().min(1).describe("How to hit the failing path"),
});

type CreateGitHubIssueResult = {
  created: boolean;
  reason?: "eval";
  owner: string;
  repo: string;
  number: number | null;
  htmlUrl: string | null;
  title: string;
};

export default defineTool({
  description:
    "Open one GitHub issue on RayedB/sentry-autofix-demo for a Sentry alert. The body includes the Sentry link, stack summary, suspected file:line, repro hint, and a line that tags @cursor. Call once per alert, after fetch_sentry_issue.",
  effect: "write",
  inputSchema,
  dryRunResult: ({ title }): CreateGitHubIssueResult => ({
    created: false,
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    number: null,
    htmlUrl: null,
    title: title.slice(0, 240),
  }),
  async execute(input, ctx): Promise<CreateGitHubIssueResult> {
    const title = input.title.slice(0, 240);
    if (isEvalSession(ctx.session.purpose)) {
      return {
        created: false,
        reason: "eval",
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        number: null,
        htmlUrl: null,
        title,
      };
    }

    const octokit = await ctx.host.github.getOctokit();
    const { data } = await octokit.rest.issues.create({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      title,
      body: [
        `Sentry: ${input.sentryUrl}`,
        "",
        "Stack:",
        input.stackSummary,
        "",
        `Suspected: ${input.suspectedFile}:${input.suspectedLine}`,
        "",
        `Repro: ${input.reproHint}`,
        "",
        "@cursor",
      ].join("\n"),
    });
    const sentryIssueId = sentryIssueIdFromContinuation(ctx.session.continuationKey);
    if (sentryIssueId !== null && data.number > 0) {
      const memory = parseSentryIssueMemory(await ctx.host.kv.get(sentryIssueKey(sentryIssueId)));
      await ctx.host.kv.put(
        issueLinkKey(data.number),
        issueLinkJson({
          sentryIssueId,
          githubIssueNumber: data.number,
          replay: memory?.replay ?? null,
        }),
      );
    }
    return {
      created: true,
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      number: data.number,
      htmlUrl: data.html_url,
      title,
    };
  },
});
