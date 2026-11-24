import { githubChannel } from "@grok/agent-sdk/channels/github";
import { GITHUB_FULL_NAME } from "../lib/github.js";

// Credential only. The scan schedule is the only actor.
// docs/guides/github.md — cursorAccount. `contents-write` is the tier that
// can push and merge; `pr-write` has no contents:write.
export default githubChannel({
  cursorAccount: {
    repos: [GITHUB_FULL_NAME],
    permissions: "contents-write",
  },
  // docs/guides/github.md and GitHubChannelOptions.onPullRequest: with no hook,
  // opened / synchronize / reopened / ready_for_review start a model turn.
  onPullRequest: () => null,
});
