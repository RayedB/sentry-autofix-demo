import { launchCloudAgent } from "@grok/agent-sdk/extensions/cursor-cloud-agents";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { fixAgentId } from "../lib/agent-id.js";
import { GITHUB_REPO_URL } from "../lib/github.js";
import { fixPrompt } from "../lib/prompt.js";

const inputSchema = z.object({
  prNumber: z.number().int().positive().describe("Pull request number"),
  attempt: z.number().int().positive().describe("Fix attempt, from 1 to 3"),
  headSha: z.string().min(1).describe("Head SHA this attempt starts from"),
  prUrl: z.string().url().describe("Pull request URL"),
  failure: z.string().nullable().describe("Why the previous attempt failed"),
});

type LaunchFixResult = {
  agentId: string;
  url: string;
};

export default defineTool({
  description: "Launch one cloud agent to push a production-code fix onto this pull request's current branch.",
  effect: "write",
  inputSchema,
  dryRunResult: (): LaunchFixResult => ({ agentId: "", url: "" }),
  async execute(input, ctx): Promise<LaunchFixResult> {
    const allowed = `${GITHUB_REPO_URL}/pull/`;
    if (!input.prUrl.startsWith(allowed)) {
      throw new Error(`prUrl must start with ${allowed}`);
    }
    const agentId = fixAgentId(input.prNumber, input.headSha, input.attempt);
    const launched = await launchCloudAgent(ctx, {
      prompt: fixPrompt(input),
      name: `fix ${input.prNumber} attempt ${input.attempt}`.slice(0, 100),
      agentId,
      cloud: {
        repos: [{ url: GITHUB_REPO_URL, prUrl: input.prUrl }],
        autoCreatePR: false,
        workOnCurrentBranch: true,
      },
    });
    return { agentId: launched.agentId, url: launched.url };
  },
});
