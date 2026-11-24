import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `isStopped` is declared in dist/extensions/cursor-cloud-agents/lib/backend.d.ts
// (lines 19-22): finished, error, or expired. "unknown" is not a stop.
// The package export `@grok/agent-sdk/extensions/cursor-cloud-agents` does not re-export it.
const require = createRequire(import.meta.url);
const backendPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/@grok/agent-sdk/dist/extensions/cursor-cloud-agents/lib/backend.js",
);

export const isStopped = require(backendPath).isStopped as (status: string) => boolean;
