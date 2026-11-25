import { PROD_ORIGIN } from "./replay.js";

export function prodVerifyPrompt(input: {
  path: string;
  description: string;
  testPath: string | null;
  prodSha: string;
}): string {
  const test = input.testPath === null ? "There is no Playwright path." : `Playwright test: ${input.testPath}`;
  return [
    "Verify a merged fix in production. Read only.",
    "Do not edit files, commit, push, or open a pull request.",
    `Production origin: ${PROD_ORIGIN}`,
    `Production SHA: ${input.prodSha}`,
    `Page path: ${input.path}`,
    `Expected behavior: ${input.description}`,
    test,
    "",
    "Run Playwright against that production origin.",
    "When the test path is an end-to-end test, run that file with its base URL set to the production origin. Do not boot a local server.",
    "Otherwise perform the UI flow on that page.",
    "Pass only when there are zero uncaught pageerror events, zero 5xx responses, and the expected behavior holds.",
    "",
    'Finish with only this JSON: {"passed":true,"summary":"..."} or {"passed":false,"summary":"..."}',
  ].join("\n");
}
