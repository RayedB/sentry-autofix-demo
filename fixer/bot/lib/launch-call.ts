import { isRecord } from "./json.js";
import type { ToolCaller } from "./runtime.js";
import type { FixRecord } from "./state.js";

export async function launchRecord(callTool: ToolCaller, record: FixRecord): Promise<void> {
  const outcome = await callTool("launch_fix", {
    prNumber: record.prNumber,
    attempt: record.attempts,
    headSha: record.sourceSha,
  });
  if (outcome.isError) {
    throw new Error(outcome.errorMessage ?? "launch_fix failed");
  }
  if (!isRecord(outcome.result) || outcome.result.launched !== true) {
    const reason = isRecord(outcome.result) && typeof outcome.result.reason === "string" ? outcome.result.reason : "launch_fix did not launch";
    throw new Error(reason);
  }
}
