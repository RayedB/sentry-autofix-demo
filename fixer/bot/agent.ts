import { defineAgent } from "@grok/agent-sdk";

// docs/reference/agent-config.md — model is optional and defaults to grok-4.7.
export default defineAgent({
  hosting: {
    egressDomains: ["*.vercel.app"],
    secretNames: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
  },
});
