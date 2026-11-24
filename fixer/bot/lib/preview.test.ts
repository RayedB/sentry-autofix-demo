import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  branchPreviewUrl,
  choosePreview,
  judgeQuoteResponse,
  previewFromCommitStatus,
  previewFromDeploymentStatusPayload,
  QUOTE_REQUEST_JSON,
  resolvePreviewUrl,
  VERCEL_BYPASS_HEADER,
  VERCEL_BYPASS_SECRET_NAME,
  vercelPreviewUrl,
  verifyPreviewQuote,
} from "./preview.js";

const BRANCH = "cursor/repro-6-1efe";
const PREVIEW = "https://sentry-autofix-demo-git-cursor-repro-6-1efe-rayeds-projects.vercel.app";
const SHA = "ddb25ec0c39385ce9e51dd3550f3c21fe0459084";

describe("preview URL resolution", () => {
  it("builds the Vercel branch alias for the repro branch", () => {
    assert.equal(branchPreviewUrl(BRANCH), PREVIEW);
  });

  it("keeps a deployment_status environment URL and drops the Vercel dashboard URL", () => {
    const hit = previewFromDeploymentStatusPayload({
      deployment: {
        sha: SHA,
        ref: BRANCH,
        environment: "Preview",
        production_environment: false,
      },
      deployment_status: {
        state: "success",
        environment: "Preview",
        environment_url: `${PREVIEW}/`,
        target_url: "https://vercel.com/rayeds-projects/sentry-autofix-demo/abc",
      },
    });
    assert.deepEqual(hit, { sha: SHA, state: "success", url: PREVIEW, preview: true });
  });

  it("ignores a production deployment and an inactive status", () => {
    assert.equal(
      previewFromDeploymentStatusPayload({
        deployment: { sha: SHA, environment: "Production", production_environment: true },
        deployment_status: {
          state: "success",
          environment: "Production",
          environment_url: "https://sentry-autofix-demo.vercel.app",
        },
      })?.preview,
      false,
    );
    assert.equal(
      previewFromDeploymentStatusPayload({
        deployment: { sha: SHA, environment: "Preview" },
        deployment_status: { state: "inactive", environment: "Preview", environment_url: PREVIEW },
      }),
      null,
    );
  });

  it("reads a Vercel commit status and ignores other contexts", () => {
    assert.equal(previewFromCommitStatus({ sha: SHA, state: "success", context: "Vercel", targetUrl: PREVIEW })?.url, PREVIEW);
    assert.equal(
      previewFromCommitStatus({
        sha: SHA,
        state: "success",
        context: "ci/test",
        targetUrl: "https://github.com/RayedB/sentry-autofix-demo/actions/runs/1",
      }),
      null,
    );
  });

  it("falls back to the branch alias only after a successful deploy with no preview URL", () => {
    assert.equal(resolvePreviewUrl({ state: "success", url: null }, BRANCH), PREVIEW);
    assert.equal(resolvePreviewUrl({ state: "pending", url: null }, BRANCH), null);
    assert.equal(vercelPreviewUrl("https://vercel.com/rayeds-projects/sentry-autofix-demo"), null);
  });

  it("prefers a ready preview over a later failure", () => {
    const chosen = choosePreview([
      { sha: SHA, state: "failure", url: null, preview: true },
      { sha: SHA, state: "success", url: PREVIEW, preview: true },
    ]);
    assert.equal(chosen?.url, PREVIEW);
  });
});

describe("verify step", () => {
  it("posts the quote body and accepts a delivery label and numeric delivery", async () => {
    const calls: Array<{ url: string; body: string; method: string }> = [];
    const verdict = await verifyPreviewQuote(PREVIEW, async (input, init) => {
      calls.push({
        url: String(input),
        body: String(init?.body),
        method: init?.method ?? "",
      });
      return new Response(JSON.stringify({ deliveryLabel: "New York", delivery: 900, total: 2800 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    assert.deepEqual(verdict, { ok: true, deliveryLabel: "New York", delivery: 900 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url, `${PREVIEW}/api/quote`);
    assert.equal(calls[0]?.body, QUOTE_REQUEST_JSON);
    assert.equal(QUOTE_REQUEST_JSON, '{"lines":[{"sku":"ethiopia","quantity":1}],"postalCode":"10001"}');
  });

  it("rejects a non-200 response, a missing label, and a non-numeric delivery", () => {
    assert.equal(judgeQuoteResponse(500, { message: "nope" }, "nope").ok, false);
    assert.equal(judgeQuoteResponse(200, { delivery: 100 }, "{}").ok, false);
    assert.equal(judgeQuoteResponse(200, { deliveryLabel: "New York", delivery: "900" }, "{}").ok, false);
    const ok = judgeQuoteResponse(200, { deliveryLabel: "New York", delivery: 0 }, "");
    assert.deepEqual(ok, { ok: true, deliveryLabel: "New York", delivery: 0 });
  });

  it("sends the Vercel protection bypass header when the secret is set", async () => {
    const previous = process.env[VERCEL_BYPASS_SECRET_NAME];
    process.env[VERCEL_BYPASS_SECRET_NAME] = "test-bypass";
    try {
      let header = "";
      await verifyPreviewQuote(PREVIEW, async (_input, init) => {
        const headers = new Headers(init?.headers);
        header = headers.get(VERCEL_BYPASS_HEADER) ?? "";
        return new Response(JSON.stringify({ deliveryLabel: "New York", delivery: 1 }), { status: 200 });
      });
      assert.equal(header, "test-bypass");
    } finally {
      if (previous === undefined) {
        delete process.env[VERCEL_BYPASS_SECRET_NAME];
      } else {
        process.env[VERCEL_BYPASS_SECRET_NAME] = previous;
      }
    }
  });

  it("refuses a URL that is not a preview host", async () => {
    const verdict = await verifyPreviewQuote("https://sentry-autofix-demo.vercel.app");
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.status, 0);
    }
  });
});
