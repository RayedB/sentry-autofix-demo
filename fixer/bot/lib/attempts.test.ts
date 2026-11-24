import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAttempt, MAX_FIX_ATTEMPTS } from "./attempts.js";

describe("attempt counting", () => {
  it("launches attempts 1 through 3", () => {
    assert.deepEqual(decideAttempt(0), { action: "launch", attempt: 1 });
    assert.deepEqual(decideAttempt(1), { action: "launch", attempt: 2 });
    assert.deepEqual(decideAttempt(2), { action: "launch", attempt: 3 });
  });

  it("stops once three launches have been used", () => {
    assert.equal(MAX_FIX_ATTEMPTS, 3);
    assert.deepEqual(decideAttempt(3), { action: "stop" });
    assert.deepEqual(decideAttempt(4), { action: "stop" });
  });

  it("rejects a fractional count", () => {
    assert.throws(() => decideAttempt(1.5), /non-negative integer/);
  });
});
