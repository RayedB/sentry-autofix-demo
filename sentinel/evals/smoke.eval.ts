import { defineEval } from "@grok/agent-sdk/evals";
import { loadJson } from "@grok/agent-sdk/evals/loaders";
import { readEventAlert } from "../bot/lib/alert.js";

const fixture = await loadJson<unknown>("fixtures/sentry/event-alert.json");
const alert = readEventAlert(fixture, "event_alert");
if (alert.kind !== "accept") {
  throw new Error("event-alert fixture was not accepted as a triggered event_alert");
}

export default defineEval({
  tags: ["smoke"],
  description: "A Sentry event_alert calls fetch_sentry_issue, create_github_issue, then cloud__launch.",
  async test(t) {
    await t.send(alert.message, {
      workspaceFiles: {
        "sentry/event-alert.json": alert.snapshot,
      },
    });
    t.succeeded();
    t.toolOrder(["fetch_sentry_issue", "create_github_issue", "cloud__launch"]);
    t.calledTool("fetch_sentry_issue", { input: { issueId: "482910331" } });
    t.calledTool("create_github_issue", {
      status: "completed",
      output: { created: false, reason: "eval" },
    });
    t.notCalledTool("comment_github_issue");
  },
});
