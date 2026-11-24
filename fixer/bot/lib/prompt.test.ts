import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixPrompt } from "./prompt.js";
import { QUOTE_REQUEST_JSON } from "./preview.js";
import type { FixRecord } from "./state.js";

const record: FixRecord = {
  prNumber: 7,
  branch: "cursor/repro-6-1efe",
  attempts: 2,
  launchFailures: 0,
  phase: "launching",
  sourceSha: "abc",
  verifySha: null,
  previewUrl: null,
  previewOk: false,
  ci: "failure",
  failure: "HTTP 500 reading label",
  cloudAgentId: null,
};

describe("fix prompt", () => {
  it("keeps the repro test and includes the quote check and the earlier failure", () => {
    const prompt = fixPrompt({
      record,
      prUrl: "https://github.com/RayedB/sentry-autofix-demo/pull/7",
      currentSha: "abc",
    });
    assert.match(prompt, /same branch/);
    assert.match(prompt, /Leave test files byte-for-byte unchanged/);
    assert.match(prompt, /production code only/);
    assert.match(prompt, new RegExp(QUOTE_REQUEST_JSON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(prompt, /HTTP 500 reading label/);
  });
});
