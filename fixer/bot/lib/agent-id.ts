import { createHash } from "node:crypto";

/** Stable `bc-<uuid>` so a repeated launch for the same attempt is one cloud agent. */
export function fixAgentId(prNumber: number, sha: string, attempt: number): string {
  const hex = createHash("sha256").update(`fixer:${prNumber}:${sha}:${attempt}`).digest("hex").slice(0, 32);
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
