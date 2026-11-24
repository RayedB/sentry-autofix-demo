import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runKey, type FixRecord } from "./state.js";
import { syncPull, type Kv, type Observation, type PullInfo, type SyncDeps } from "./sync.js";

const PREVIEW = "https://sentry-autofix-demo-git-cursor-repro-6-1efe-rayeds-projects.vercel.app";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEXT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function memoryKv(): Kv & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
}

function pull(sha: string): PullInfo {
  return {
    number: 7,
    url: "https://github.com/RayedB/sentry-autofix-demo/pull/7",
    branch: "cursor/repro-6-1efe",
    sha,
    body: "Refs #6",
    labels: [],
    open: true,
    merged: false,
  };
}

function failing(detail = "vitest failed"): Observation {
  return { ci: "failure", previewState: "none", previewUrl: null, detail };
}

function harness(kv: Kv): SyncDeps & { launches: FixRecord[]; merges: string[]; comments: string[]; probes: string[] } {
  const launches: FixRecord[] = [];
  const merges: string[] = [];
  const comments: string[] = [];
  const probes: string[] = [];
  return {
    kv,
    launches,
    merges,
    comments,
    probes,
    async probe(url) {
      probes.push(url);
      return { ok: false, status: 500, reason: "HTTP 500.", body: "reading 'label'" };
    },
    async launch(record) {
      launches.push(record);
      const saved = await kv.get(runKey(record.prNumber));
      if (typeof saved === "object" && saved !== null) {
        await kv.put(runKey(record.prNumber), { ...saved, cloudAgentId: "bc-11111111-1111-1111-1111-111111111111" });
      }
    },
    async comment(_pr, body) {
      comments.push(body);
    },
    async merge(_pr, sha) {
      merges.push(sha);
    },
  };
}

describe("syncPull", () => {
  it("launches once for a failing head and ignores the same head after the agent id is stored", async () => {
    const kv = memoryKv();
    const deps = harness(kv);
    await syncPull(deps, pull(SHA), failing());
    await syncPull(deps, pull(SHA), failing());
    assert.equal(deps.launches.length, 1);
    assert.equal(deps.launches[0]?.attempts, 1);
    assert.equal(deps.merges.length, 0);
  });

  it("probes the new head and squash-merges once when CI and the quote both pass", async () => {
    const kv = memoryKv();
    const deps = harness(kv);
    await syncPull(deps, pull(SHA), failing());
    deps.probe = async (url) => {
      deps.probes.push(url);
      return { ok: true, deliveryLabel: "New York", delivery: 900 };
    };
    const ready = {
      ci: "success" as const,
      previewState: "success" as const,
      previewUrl: PREVIEW,
      detail: "",
    };
    await syncPull(deps, pull(NEXT), ready);
    assert.equal(deps.launches.length, 1);
    assert.deepEqual(deps.probes, [PREVIEW]);
    assert.deepEqual(deps.merges, [NEXT]);
    await syncPull(deps, pull(NEXT), ready);
    assert.equal(deps.merges.length, 1);
  });

  it("launches on a failing test when Vercel Authentication hides the preview, then stops once CI is green", async () => {
    const kv = memoryKv();
    const deps = harness(kv);
    deps.probe = async (url) => {
      deps.probes.push(url);
      return { ok: false, status: 401, reason: "HTTP 401.", body: '{"error":{"message":"Protected deployment"}}' };
    };
    await syncPull(deps, pull(SHA), {
      ci: "failure",
      previewState: "success",
      previewUrl: PREVIEW,
      detail: "test failed",
    });
    assert.equal(deps.launches.length, 1);
    assert.equal(deps.merges.length, 0);
    await syncPull(deps, pull(NEXT), {
      ci: "success",
      previewState: "success",
      previewUrl: PREVIEW,
      detail: "",
    });
    assert.equal(deps.launches.length, 1);
    assert.equal(deps.merges.length, 0);
    assert.match(deps.comments[0] ?? "", /Vercel Authentication/);
  });

  it("feeds the preview failure into the next attempt and stops after the third", async () => {
    const kv = memoryKv();
    const deps = harness(kv);
    await syncPull(deps, pull(SHA), {
      ci: "failure",
      previewState: "success",
      previewUrl: PREVIEW,
      detail: "test failed",
    });
    assert.equal(deps.probes.length, 1);
    assert.match(deps.launches[0]?.failure ?? "", /HTTP 500/);
    assert.match(deps.launches[0]?.failure ?? "", /reading 'label'/);

    await syncPull(deps, pull(NEXT), failing("attempt 2"));
    await syncPull(deps, pull("c".repeat(40)), failing("attempt 3"));
    const fourth = "d".repeat(40);
    await syncPull(deps, pull(fourth), failing("attempt 4"));
    assert.equal(deps.launches.length, 3);
    assert.equal(deps.comments.length, 1);
    assert.match(deps.comments[0] ?? "", /stopped after 3 attempts/);
    const saved = await kv.get(runKey(7));
    assert.equal(typeof saved === "object" && saved !== null && "phase" in saved ? saved.phase : "", "stopped");
  });
});
