import cursorCloudAgents from "@grok/agent-sdk/extensions/cursor-cloud-agents";
import { GITHUB_REPO_URL } from "../lib/github.js";

export default cursorCloudAgents({
  cloud: {
    repos: [{ url: GITHUB_REPO_URL, startingRef: "main" }],
    autoCreatePR: true,
  },
  needsApproval: false,
  channels: ["sentry"],
  refuseSession: (session) =>
    session.purpose === "eval" ? "Eval sessions do not launch cloud agents." : undefined,
});
