import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latestByContext, summarizeChecks, type CheckRunSnapshot } from "./checks.js";

function run(overrides: Partial<CheckRunSnapshot>): CheckRunSnapshot {
  return {
    name: "test",
    status: "completed",
    conclusion: "success",
    summary: "",
    ...overrides,
  };
}

describe("summarizeChecks", () => {
  it("stays pending until GitHub Actions has reported a check run", () => {
    assert.equal(
      summarizeChecks({
        checkRuns: [],
        statuses: [{ context: "Vercel", state: "success" }],
      }),
      "pending",
    );
  });

  it("fails when any check failed, even if another is still running", () => {
    assert.equal(
      summarizeChecks({
        checkRuns: [run({ name: "test", conclusion: "failure" }), run({ name: "e2e", status: "in_progress", conclusion: null })],
        statuses: [],
      }),
      "failure",
    );
  });

  it("is green only when every check run completed successfully and statuses agree", () => {
    assert.equal(
      summarizeChecks({
        checkRuns: [run({ name: "test" }), run({ name: "e2e", conclusion: "skipped" })],
        statuses: [
          { context: "Vercel", state: "pending" },
          { context: "Vercel", state: "success" },
        ],
      }),
      "pending",
    );
    assert.equal(
      summarizeChecks({
        checkRuns: [run({ name: "test" }), run({ name: "e2e" })],
        statuses: latestByContext([
          { context: "Vercel", state: "success" },
          { context: "Vercel", state: "pending" },
        ]),
      }),
      "success",
    );
  });
});
