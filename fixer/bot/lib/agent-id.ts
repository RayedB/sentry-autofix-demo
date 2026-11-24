import { createHash } from "node:crypto";

const AGENT_ID = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stable `bc-<uuid>` so a repeated launch for the same attempt returns one cloud agent. */
export function fixAgentId(prNumber: number, sha: string, attempt: number): string {
  const hex = createHash("sha256")
    .update(`fixer:${prNumber}:${sha}:${attempt}`)
    .digest("hex")
    .slice(0, 32);
  const id = `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!AGENT_ID.test(id)) {
    throw new Error("fixAgentId produced a value the Cloud Agents API would reject.");
  }
  return id;
}
