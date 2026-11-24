import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide, type FixRecord, type View } from "./state.js";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEXT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function view(overrides: Partial<View> = {}): View {
  return {
    repro: true,
    prNumber: 7,
    branch: "cursor/repro-6-1efe",
    sha: SHA,
    ci: "failure",
    previewState: "none",
    previewUrl: null,
    previewOk: null,
    detail: "test failed",
    ...overrides,
  };
}

function record(overrides: Partial<FixRecord> = {}): FixRecord {
  return {
    prNumber: 7,
    branch: "cursor/repro-6-1efe",
    attempts: 1,
    launchFailures: 0,
    phase: "launching",
    sourceSha: SHA,
    verifySha: null,
    previewUrl: null,
    previewOk: null,
    ci: "failure",
    failure: "test failed",
    cloudAgentId: "bc-11111111-1111-1111-1111-111111111111",
    ...overrides,
  };
}

describe("decide", () => {
  it("launches the first attempt from a failing repro and ignores a repeat of that head", () => {
    const first = decide(null, view());
    assert.equal(first.type, "launch");
    if (first.type !== "launch") {
      return;
    }
    assert.equal(first.record.attempts, 1);
    assert.equal(first.record.sourceSha, SHA);
    assert.equal(first.record.phase, "launching");

    const armed = record({ cloudAgentId: "bc-11111111-1111-1111-1111-111111111111" });
    assert.equal(decide(armed, view()).type, "ignore");
    const resume = decide(record({ cloudAgentId: null }), view());
    assert.equal(resume.type, "launch");
    if (resume.type === "launch") {
      assert.equal(resume.record.attempts, 1);
    }
  });

  it("does not start on a green or unrelated pull request", () => {
    assert.equal(decide(null, view({ ci: "success", previewState: "success", previewOk: true })).type, "ignore");
    assert.equal(decide(null, view({ repro: false })).type, "ignore");
  });

  it("probes a ready preview before merging", () => {
    const url = "https://sentry-autofix-demo-git-cursor-repro-6-1efe-rayeds-projects.vercel.app";
    const step = decide(
      record({ phase: "verifying", verifySha: SHA, cloudAgentId: "bc-11111111-1111-1111-1111-111111111111" }),
      view({ ci: "success", previewState: "success", previewUrl: url }),
    );
    assert.equal(step.type, "probe");
    if (step.type === "probe") {
      assert.equal(step.url, url);
    }
    const merge = decide(
      record({ phase: "verifying", verifySha: SHA }),
      view({ ci: "success", previewState: "success", previewUrl: url, previewOk: true, detail: "" }),
    );
    assert.equal(merge.type, "merge");
  });

  it("retries when the new head fails and stops on the third failure", () => {
    const retry = decide(
      record(),
      view({ sha: NEXT, ci: "failure", detail: "still failing\nlog" }),
    );
    assert.equal(retry.type, "launch");
    if (retry.type === "launch") {
      assert.equal(retry.record.attempts, 2);
      assert.equal(retry.record.sourceSha, NEXT);
      assert.equal(retry.record.cloudAgentId, null);
    }

    const stop = decide(record({ attempts: 3, phase: "verifying", verifySha: NEXT }), view({ sha: NEXT }));
    assert.equal(stop.type, "stop");
    if (stop.type === "stop") {
      assert.equal(stop.record.phase, "stopped");
      assert.equal(stop.record.attempts, 3);
    }
  });

  it("stops when CI is green but Vercel Authentication blocks the preview", () => {
    const step = decide(
      record({ phase: "verifying", verifySha: NEXT, sourceSha: SHA }),
      view({
        sha: NEXT,
        ci: "success",
        previewState: "blocked",
        detail: "Vercel Authentication blocked POST /api/quote.",
      }),
    );
    assert.equal(step.type, "stop");
  });

  it("still launches a code fix when CI failed and the preview is only blocked", () => {
    const step = decide(null, view({ previewState: "blocked", ci: "failure", detail: "test failed" }));
    assert.equal(step.type, "launch");
  });

  it("waits while the new head's CI is still running", () => {
    const step = decide(record(), view({ sha: NEXT, ci: "pending", previewState: "pending", detail: "" }));
    assert.equal(step.type, "wait");
    if (step.type === "wait") {
      assert.equal(step.record.phase, "verifying");
      assert.equal(step.record.verifySha, NEXT);
      assert.equal(step.record.attempts, 1);
    }
  });
});
