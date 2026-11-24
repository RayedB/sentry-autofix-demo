import { defineAgent } from "@grok/agent-sdk";
import { VERCEL_BYPASS_SECRET_NAME } from "./lib/preview.js";

// docs/reference/agent-config.md — model is optional and defaults to grok-4.7.
export default defineAgent({
  hosting: {
    egressDomains: ["*.vercel.app"],
    secretNames: [VERCEL_BYPASS_SECRET_NAME],
  },
});
