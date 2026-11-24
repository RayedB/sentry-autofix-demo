import { defineSchedule } from "@grok/agent-sdk/schedules";
import { syncOpen } from "../lib/host-sync.js";
import { setCallTool } from "../lib/runtime.js";

// GitHub does not replay a check_suite that failed before this agent was
// deployed. This scan notices an already-failing repro pull request.
export default defineSchedule({
  cron: "* * * * *",
  async run({ host, callTool }) {
    const caller = (name: string, input: { prNumber: number; attempt: number; headSha: string }) => callTool(name, input);
    setCallTool(caller);
    await syncOpen({
      getOctokit: () => host.github.getOctokit(),
      kv: host.kv,
      callTool: caller,
    });
  },
});
