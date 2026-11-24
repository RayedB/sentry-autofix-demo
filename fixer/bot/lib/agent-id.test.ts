import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixAgentId } from "./agent-id.js";

describe("fixAgentId", () => {
  it("is stable and shaped like a cloud agent id", () => {
    const first = fixAgentId(7, "ddb25ec0c39385ce9e51dd3550f3c21fe0459084", 1);
    const second = fixAgentId(7, "ddb25ec0c39385ce9e51dd3550f3c21fe0459084", 1);
    assert.equal(first, second);
    assert.match(first, /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(first, fixAgentId(7, "ddb25ec0c39385ce9e51dd3550f3c21fe0459084", 2));
  });
});
