import { defineSchedule } from "@grok/agent-sdk/schedules";
import { getCloudAgent } from "@grok/agent-sdk/extensions/cursor-cloud-agents";
import { githubFromOctokit } from "../lib/github-rest.js";
import { tick, type LaunchInput } from "../lib/tick.js";

// docs/reference/schedules.md — run receives callTool and host. Every two minutes.
export default defineSchedule({
  cron: "*/2 * * * *",
  async run({ host, callTool }) {
    const github = githubFromOctokit(await host.github.getOctokit());
    const pulls = await github.listOpenPulls();
    for (const pull of pulls) {
      try {
        await tick(
          {
            kv: host.kv,
            github,
            getAgent: (agentId) => getCloudAgent(agentId),
            launch: (input) => launchWith(callTool, input),
          },
          pull,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "tick failed";
        console.error(`fixer tick #${pull.number}: ${message}`);
      }
    }
  },
});

async function launchWith(
  callTool: (name: string, input?: unknown) => Promise<{ isError: boolean; errorMessage?: string; result: unknown }>,
  input: LaunchInput,
): Promise<{ agentId: string }> {
  const outcome = await callTool("launch_fix", input);
  if (outcome.isError) {
    throw new Error(outcome.errorMessage ?? "launch_fix failed");
  }
  if (typeof outcome.result !== "object" || outcome.result === null || !("agentId" in outcome.result)) {
    throw new Error("launch_fix did not return an agent id.");
  }
  const agentId = outcome.result.agentId;
  if (typeof agentId !== "string" || agentId === "") {
    throw new Error("launch_fix did not return an agent id.");
  }
  return { agentId };
}
