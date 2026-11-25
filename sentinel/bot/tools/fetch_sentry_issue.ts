import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { fetchSentryIssue, SENTRY_API_TOKEN_NAME } from "../lib/sentry.js";

export default defineTool({
  description:
    "Read one Sentry issue and its latest event from the US region: exception, in-app frames, release, request, and replay spec. Call this before opening a GitHub issue.",
  effect: "read",
  inputSchema: z.object({
    issueId: z.string().describe("Sentry issue id from data.event.issue_id"),
  }),
  async execute({ issueId }) {
    const token = process.env[SENTRY_API_TOKEN_NAME];
    if (token === undefined || token.trim() === "") {
      throw new Error(`${SENTRY_API_TOKEN_NAME} is not set.`);
    }
    return fetchSentryIssue(issueId, token);
  },
});
