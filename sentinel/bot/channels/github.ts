import { githubChannel } from "@grok/agent-sdk/channels/github";

// Mounts the Cursor account GitHub credential for ctx.host.github.
// Hooks return null so GitHub deliveries do not start a model turn.
export default githubChannel({
  botName: "sentinel",
  cursorAccount: {
    repos: ["RayedB/sentry-autofix-demo"],
    permissions: "pr-write",
  },
  // issues is outside the pull-request continuation set, so an omitted
  // selector warns and stamps github.none/v2. Pin that: these hooks never
  // start a session.
  continuation: "github.none/v2",
  onPullRequest: () => null,
  onComment: () => null,
  onIssue: () => null,
});
