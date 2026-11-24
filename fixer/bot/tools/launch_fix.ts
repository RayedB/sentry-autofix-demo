import { launchCloudAgent } from "@grok/agent-sdk/extensions/cursor-cloud-agents";
import type { JsonValue } from "@grok/agent-sdk";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { fixAgentId } from "../lib/agent-id.js";
import { GITHUB_REPO_URL, isEvalSession } from "../lib/github.js";
import { clientFrom } from "../lib/github-api.js";
import { fixPrompt } from "../lib/prompt.js";
import { isReproPull } from "../lib/repro.js";
import { parseFixRecord, runKey, type FixRecord } from "../lib/state.js";

const inputSchema = z.object({
  prNumber: z.number().int().positive().describe("Pull request number"),
  attempt: z.number().int().positive().describe("Fix attempt, from 1 to 3"),
  headSha: z.string().min(1).describe("Head SHA this attempt is fixing"),
});

type LaunchFixResult = {
  launched: boolean;
  reason?: "eval" | "stale" | "closed" | "not-repro" | "already";
  agentId?: string;
  url?: string;
};

export default defineTool({
  description:
    "Launch one Cursor cloud agent to push a production-code fix onto this repro pull request's current branch. Call once when the message starts with LAUNCH_FIX. The attempt and head SHA must match the message.",
  effect: "write",
  inputSchema,
  dryRunResult: (): LaunchFixResult => ({ launched: false }),
  async execute(input, ctx): Promise<LaunchFixResult> {
    if (isEvalSession(ctx.session.purpose)) {
      return { launched: false, reason: "eval" };
    }
    const stored = parseFixRecord(await ctx.host.kv.get(runKey(input.prNumber)));
    if (stored === null || stored.attempts !== input.attempt || stored.sourceSha !== input.headSha || stored.phase !== "launching") {
      return { launched: false, reason: "stale" };
    }
    if (stored.cloudAgentId !== null) {
      return { launched: true, reason: "already", agentId: stored.cloudAgentId };
    }

    const client = await clientFrom(() => ctx.host.github.getOctokit());
    const pull = await client.getPull(input.prNumber);
    if (pull === null || !pull.open) {
      return { launched: false, reason: "closed" };
    }
    if (!isReproPull({ ref: pull.branch, body: pull.body, labels: pull.labels })) {
      return { launched: false, reason: "not-repro" };
    }

    const agentId = fixAgentId(input.prNumber, input.headSha, input.attempt);
    const launched = await launchCloudAgent(ctx, {
      prompt: fixPrompt({ record: stored, prUrl: pull.url, currentSha: pull.sha }),
      name: `fix ${input.prNumber} attempt ${input.attempt}`.slice(0, 100),
      agentId,
      cloud: {
        repos: [{ url: GITHUB_REPO_URL, prUrl: pull.url }],
        autoCreatePR: false,
        workOnCurrentBranch: true,
      },
    });
    const next: FixRecord = { ...stored, cloudAgentId: launched.agentId };
    await ctx.host.kv.put(runKey(stored.prNumber), next as JsonValue);
    return { launched: true, agentId: launched.agentId, url: launched.url };
  },
});
