import { QUOTE_REQUEST } from "./preview.js";

export function fixPrompt(input: { prUrl: string; headSha: string; attempt: number; failure: string | null }): string {
  const failure = input.failure === null || input.failure.trim() === "" ? "No earlier attempt failed." : input.failure.trim().slice(0, 4000);
  return [
    "First, merge origin/main into this branch so the preview serves GET /api/version.",
    "Then fix the production bug on this existing pull request.",
    `Pull request: ${input.prUrl}`,
    `Push every commit onto that same branch. The pull request already exists.`,
    `Attempt ${input.attempt} of 3. Current head ${input.headSha}.`,
    "",
    "Leave test files byte-for-byte unchanged, including the failing repro test.",
    "The fix is production code only.",
    "The known repro is a one-bag Ethiopia order to postal code 10001. deliveryFor in lib/pricing.ts reads label when ZONES has no entry for prefix 100.",
    "",
    "Done when this JSON POST to /api/quote returns HTTP 200 with a non-empty deliveryLabel and a numeric delivery:",
    JSON.stringify(QUOTE_REQUEST),
    "",
    "Earlier failure:",
    failure,
    "",
    'Finish with only this JSON: {"pushed":true,"sha":"<new head sha>"}',
  ].join("\n");
}
