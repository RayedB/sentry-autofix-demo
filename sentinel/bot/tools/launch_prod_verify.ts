import { launchCloudAgent } from "@grok/agent-sdk/extensions/cursor-cloud-agents";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { verifyAgentId } from "../lib/agent-id.js";
import { GITHUB_REPO_URL } from "../lib/github.js";
import { prodVerifyPrompt } from "../lib/prompt.js";
import { isSafeProdPath, isSafeTestPath } from "../lib/replay.js";

const SHA = /^[0-9a-f]{7,64}$/i;

const inputSchema = z.object({
  prNumber: z.number().int().positive().describe("Merged pull request number"),
  path: z.string().min(1).describe("Relative production page path"),
  description: z.string().min(1).describe("UI behavior that should hold in production"),
  testPath: z.string().min(1).optional().describe("Playwright test path from the repro pull request"),
  prodSha: z.string().min(7).describe("Production commit the deploy is serving"),
});

type LaunchProdVerifyResult = {
  agentId: string;
  url: string;
};

export default defineTool({
  description:
    "Launch one read-only cloud agent to run Playwright against production for a browser bug. It must not edit, commit, push, or open a pull request.",
  effect: "write",
  inputSchema,
  dryRunResult: (): LaunchProdVerifyResult => ({ agentId: "", url: "" }),
  async execute(input, ctx): Promise<LaunchProdVerifyResult> {
    if (ctx.session.channelId !== "direct") {
      throw new Error("launch_prod_verify can only run from the verify schedule.");
    }
    if (!isSafeProdPath(input.path)) {
      throw new Error("path must be a relative path on the production origin.");
    }
    if (!SHA.test(input.prodSha)) {
      throw new Error("prodSha must be a git commit sha.");
    }
    const testPath = input.testPath ?? null;
    if (testPath !== null && !isSafeTestPath(testPath)) {
      throw new Error("testPath must be a relative repository path.");
    }
    const description = input.description.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 2_000);
    const launched = await launchCloudAgent(ctx, {
      prompt: prodVerifyPrompt({ path: input.path, description, testPath, prodSha: input.prodSha }),
      name: `verify ${input.prNumber}`.slice(0, 100),
      agentId: verifyAgentId(input.prNumber, input.prodSha),
      cloud: {
        repos: [{ url: GITHUB_REPO_URL, startingRef: "main" }],
        autoCreatePR: false,
      },
    });
    return { agentId: launched.agentId, url: launched.url };
  },
});
