import { QUOTE_REQUEST_JSON } from "./preview.js";
import { clip, type FixRecord } from "./state.js";

export function fixPrompt(input: { record: FixRecord; prUrl: string; currentSha: string }): string {
  const failure =
    input.record.failure === null || input.record.failure.trim() === ""
      ? "No earlier attempt failed."
      : clip(input.record.failure, 4000);
  return [
    "Fix the production bug on this existing pull request.",
    `Pull request: ${input.prUrl}`,
    `Branch: ${input.record.branch}`,
    `Push every commit onto that same branch. The pull request already exists.`,
    `Attempt ${input.record.attempts} of 3. Recorded head ${input.record.sourceSha}. Current head ${input.currentSha}.`,
    "",
    "Leave test files byte-for-byte unchanged, including the failing repro test.",
    "The fix is production code only. A change that deletes, skips, or weakens a test is not a fix.",
    "The known repro is a one-bag Ethiopia order to postal code 10001. deliveryFor in lib/pricing.ts reads label when ZONES has no entry for prefix 100.",
    "",
    "Done when this JSON POST to /api/quote returns HTTP 200 with a non-empty deliveryLabel and a numeric delivery:",
    QUOTE_REQUEST_JSON,
    "",
    "Earlier failure:",
    failure,
    "",
    'Finish with only this JSON: {"pushed":true,"sha":"<new head sha>"}',
  ].join("\n");
}
