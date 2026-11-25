import { createHash } from "node:crypto";

/** Stable `bc-<uuid>` so a repeated production check for the same deploy is one cloud agent. */
export function verifyAgentId(prNumber: number, prodSha: string): string {
  const hex = createHash("sha256").update(`sentinel-verify:${prNumber}:${prodSha}`).digest("hex").slice(0, 32);
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
