import { getCloudAgent } from "@grok/agent-sdk/extensions/cursor-cloud-agents";
import { defineSchedule } from "@grok/agent-sdk/schedules";
import { githubFromOctokit } from "../lib/github-rest.js";
import { isRecord, readString } from "../lib/json.js";
import { fetchSentryIssue, listProductionEvents, resolveSentryIssue, SENTRY_API_TOKEN_NAME } from "../lib/sentry.js";
import { verifyTick, type LaunchVerifyInput } from "../lib/verify.js";

// docs/reference/schedules.md — run receives callTool and host. Every two minutes.
export default defineSchedule({
  cron: "*/2 * * * *",
  async run({ host, callTool }) {
    const github = githubFromOctokit(await host.github.getOctokit());
    const pulls = await github.listRecentClosedPulls();
    for (const pull of pulls) {
      try {
        await verifyTick(
          {
            kv: host.kv,
            github,
            getAgent: (agentId) => getCloudAgent(agentId),
            launch: (input) => launchWith(callTool, input),
            sentry: {
              fetchIssue: async (issueId) => {
                const snap = await fetchSentryIssue(issueId, token());
                return { replay: snap.replay };
              },
              listProductionEvents: (issueId, sinceIso, prodSha) => listProductionEvents(issueId, sinceIso, prodSha, token()),
              resolveIssue: (issueId) => resolveSentryIssue(issueId, token()),
            },
          },
          pull,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "verify failed";
        console.error(`sentinel verify #${pull.number}: ${message}`);
      }
    }
  },
});

function token(): string {
  const value = process.env[SENTRY_API_TOKEN_NAME]?.trim() ?? "";
  if (value === "") {
    throw new Error(`${SENTRY_API_TOKEN_NAME} is not set.`);
  }
  return value;
}

async function launchWith(
  callTool: (name: string, input?: unknown) => Promise<{ isError: boolean; errorMessage?: string; result: unknown }>,
  input: LaunchVerifyInput,
): Promise<{ agentId: string; url: string }> {
  const outcome = await callTool("launch_prod_verify", {
    prNumber: input.prNumber,
    path: input.path,
    description: input.description,
    prodSha: input.prodSha,
    ...(input.testPath !== null ? { testPath: input.testPath } : {}),
  });
  if (outcome.isError) {
    throw new Error(outcome.errorMessage ?? "launch_prod_verify failed");
  }
  if (!isRecord(outcome.result)) {
    throw new Error("launch_prod_verify did not return an agent id.");
  }
  const agentId = readString(outcome.result, "agentId");
  if (agentId === null) {
    throw new Error("launch_prod_verify did not return an agent id.");
  }
  const url = typeof outcome.result.url === "string" ? outcome.result.url : "";
  return { agentId, url };
}
