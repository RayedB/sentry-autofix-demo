import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReproPull, isReproRef, REPRO_MARKER } from "./repro.js";

describe("repro marker", () => {
  it("recognizes the cloud-agent branch used on the existing repro pull request", () => {
    assert.equal(isReproRef("cursor/repro-6-1efe"), true);
    assert.equal(
      isReproPull({ ref: "cursor/repro-6-1efe", body: "Refs #6", labels: [] }),
      true,
    );
  });

  it("recognizes a sentinel branch and the body or label marker", () => {
    assert.equal(isReproRef("repro/6"), true);
    assert.equal(isReproPull({ ref: "feature/quote", body: `line\n${REPRO_MARKER}\n`, labels: [] }), true);
    assert.equal(isReproPull({ ref: "feature/quote", body: "", labels: [REPRO_MARKER] }), true);
  });

  it("leaves unrelated branches alone", () => {
    assert.equal(isReproRef("cursor/reproduce-docs"), false);
    assert.equal(isReproRef("main"), false);
    assert.equal(isReproPull({ ref: "main", body: "Refs #6", labels: [] }), false);
  });
});
