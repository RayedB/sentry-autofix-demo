import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonValue } from "@grok/agent-sdk";
import { getGitHubChannelOptions } from "@grok/agent-sdk/channels/github";
import channel from "../channels/github.js";
import { runKey, type FixRecord } from "./record.js";
import { tick, type ComparedFile, type GitHub, type OpenPull } from "./tick.js";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEXT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PREVIEW = "https://sentry-autofix-demo-git-cursor-repro-6-1efe-rayeds-projects.vercel.app";

const vercelStatus = {
  id: 1,
  context: "Vercel",
  state: "success",
  target_url: "https://vercel.com/rayeds-projects/sentry-autofix-demo/8Ngsbiuob5ifzjaPMkYzPmgLUSwj",
  description: "Deployment has completed",
  created_at: "2026-11-23T16:17:47Z",
  updated_at: "2026-11-23T16:17:47Z",
};

function checks(
  names: Array<{ name: string; conclusion: string | null; status?: string; output?: { title?: string; summary?: string } }>,
) {
  return {
    total_count: names.length,
    check_runs: names.map((run, index) => ({
      id: index + 1,
      name: run.name,
      status: run.status ?? "completed",
      conclusion: run.conclusion,
      output: run.output ?? { title: null, summary: null },
      html_url: `https://github.com/RayedB/sentry-autofix-demo/runs/${index + 1}`,
    })),
  };
}

function pull(overrides: Partial<OpenPull> = {}): OpenPull {
  return {
    number: 7,
    sha: SHA,
    ref: "cursor/repro-6-1efe",
    repoFullName: "RayedB/sentry-autofix-demo",
    labels: ["sentry-repro"],
    htmlUrl: "https://github.com/RayedB/sentry-autofix-demo/pull/7",
    merged: false,
    ...overrides,
  };
}

function memory() {
  const values = new Map<string, JsonValue>();
  return {
    values,
    kv: {
      async get(key: string) {
        return values.get(key);
      },
      async put(key: string, value: JsonValue) {
        values.set(key, value);
      },
    },
    record(): FixRecord | undefined {
      return values.get(runKey(7)) as FixRecord | undefined;
    },
  };
}

function github(overrides: Partial<GitHub> = {}): GitHub & { calls: string[]; comments: string[] } {
  const calls: string[] = [];
  const comments: string[] = [];
  const mark = (name: string) => {
    calls.push(name);
  };
  return {
    calls,
    comments,
    async listCheckRuns() {
      mark("listCheckRuns");
      return checks([
        { name: "test", conclusion: "success" },
        { name: "e2e", conclusion: "success" },
      ]);
    },
    async listStatuses() {
      mark("listStatuses");
      return [vercelStatus];
    },
    async compareFiles() {
      mark("compareFiles");
      return [] as ComparedFile[];
    },
    async comment(_number, body) {
      mark("comment");
      comments.push(body);
    },
    async merge() {
      mark("merge");
    },
    async getPull(number) {
      mark("getPull");
      return pull({ number, merged: false });
    },
    ...overrides,
  };
}

function harness(options: { pull?: OpenPull; github?: Partial<GitHub>; record?: Partial<FixRecord>; fetchImpl?: typeof fetch; agent?: { status: string } } = {}) {
  const store = memory();
  if (options.record) {
    const full: FixRecord = {
      prNumber: 7,
      reproSha: SHA,
      attempts: 0,
      agentId: null,
      attemptSha: null,
      lastFailure: null,
      pendingSince: null,
      phase: "active",
      ...options.record,
    };
    store.values.set(runKey(full.prNumber), full);
  }
  const gh = github(options.github);
  const launches: Array<{ attempt: number; headSha: string; failure: string | null }> = [];
  return {
    store,
    gh,
    launches,
    async run() {
      await tick(
        {
          kv: store.kv,
          github: gh,
          getAgent: async () => options.agent ?? { status: "finished" },
          launch: async (input) => {
            launches.push({ attempt: input.attempt, headSha: input.headSha, failure: input.failure });
            return { agentId: `bc-attempt-${input.attempt}` };
          },
          fetchImpl: options.fetchImpl,
        },
        options.pull ?? pull(),
      );
    },
  };
}

function quoteFetch(headSha: string, status = 200): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, "manual");
    if (url.endsWith("/api/version")) {
      return new Response(JSON.stringify({ sha: headSha }), { status: 200 });
    }
    return new Response(JSON.stringify({ deliveryLabel: "New York", delivery: 900 }), { status });
  }) as typeof fetch;
}

describe("tick", () => {
  it("ignores a fork and makes no further GitHub calls", async () => {
    const run = harness({ pull: pull({ repoFullName: "other/sentry-autofix-demo", ref: "cursor/repro-6-1efe" }) });
    await run.run();
    assert.deepEqual(run.gh.calls, []);
    assert.equal(run.launches.length, 0);
  });

  it("does not merge when the e2e check run is missing", async () => {
    const run = harness({
      github: {
        async listCheckRuns() {
          return checks([{ name: "test", conclusion: "success" }]);
        },
      },
    });
    await run.run();
    assert.equal(run.gh.calls.includes("merge"), false);
    assert.equal(run.launches.length, 0);
    assert.equal(run.store.record(), undefined);
  });

  it("comments and does not merge when a test file changed", async () => {
    const run = harness({
      pull: pull({ sha: NEXT }),
      record: { prNumber: 7, reproSha: SHA, attempts: 1, agentId: "bc-attempt-1", lastFailure: null, phase: "active" },
      fetchImpl: quoteFetch(NEXT),
      github: {
        async compareFiles(_base, head) {
          const sha = head === SHA ? "blob-repro" : "blob-edited";
          return [{ path: "lib/pricing.test.ts", sha, status: "added" }];
        },
      },
    });
    await run.run();
    assert.equal(run.gh.calls.includes("merge"), false);
    assert.equal(run.gh.comments.length, 1);
    assert.match(run.gh.comments[0] ?? "", /pricing\.test\.ts/);
    assert.equal(run.store.record()?.phase, "stopped");
  });

  it("uses one attempt when a finished agent left the head unchanged", async () => {
    const run = harness({
      record: {
        prNumber: 7,
        reproSha: SHA,
        attempts: 1,
        agentId: "bc-attempt-1",
        attemptSha: SHA,
        lastFailure: "CI failed.",
        phase: "active",
      },
      agent: { status: "finished" },
      github: {
        async listCheckRuns() {
          return checks([
            {
              name: "test",
              conclusion: "failure",
              output: { title: "vitest", summary: "pricing label" },
            },
            { name: "e2e", conclusion: "success" },
          ]);
        },
      },
    });
    await run.run();
    assert.deepEqual(
      run.launches.map(({ attempt, headSha }) => ({ attempt, headSha })),
      [{ attempt: 2, headSha: SHA }],
    );
    assert.match(run.launches[0]?.failure ?? "", /pricing label/);
    assert.equal(run.store.record()?.attempts, 2);
    assert.equal(run.store.record()?.agentId, "bc-attempt-2");
  });

  it("stops with one comment after three failures", async () => {
    const run = harness({
      github: {
        async listCheckRuns() {
          return checks([{ name: "test", conclusion: "failure" }, { name: "e2e", conclusion: "failure" }]);
        },
      },
      agent: { status: "finished" },
    });
    await run.run();
    await run.run();
    await run.run();
    await run.run();
    assert.equal(run.launches.length, 3);
    assert.equal(run.gh.comments.length, 1);
    assert.match(run.gh.comments[0] ?? "", /stopped after 3 attempts/);
    assert.equal(run.store.record()?.phase, "stopped");
  });

  it("treats an already-merged pull request as merged and posts no failure comment", async () => {
    const run = harness({
      record: { attempts: 1, reproSha: SHA },
      fetchImpl: quoteFetch(SHA),
      github: {
        async merge() {
          throw Object.assign(new Error("Pull Request is not mergeable"), { status: 405 });
        },
        async getPull(number) {
          return pull({ number, merged: true });
        },
      },
    });
    await run.run();
    assert.equal(run.store.record()?.phase, "merged");
    assert.equal(run.gh.comments.length, 1);
    assert.doesNotMatch(run.gh.comments[0] ?? "", /fail/i);
  });

  it("makes zero GitHub calls when the record is already terminal", async () => {
    const run = harness({
      record: { prNumber: 7, reproSha: SHA, attempts: 3, agentId: null, lastFailure: "CI failed.", phase: "stopped" },
    });
    await run.run();
    assert.deepEqual(run.gh.calls, []);
    assert.equal(run.launches.length, 0);
  });

  it("posts the quote to the branch alias after the preview SHA matches, ignoring the Vercel dashboard URL", async () => {
    const urls: string[] = [];
    const run = harness({
      record: { attempts: 1, reproSha: SHA, agentId: null },
      fetchImpl: (async (input, init) => {
        const url = String(input);
        urls.push(url);
        assert.equal(init?.redirect, "manual");
        if (url.endsWith("/api/version")) {
          return new Response(JSON.stringify({ sha: SHA }), { status: 200 });
        }
        return new Response(JSON.stringify({ deliveryLabel: "New York", delivery: 900 }), { status: 200 });
      }) as typeof fetch,
    });
    await run.run();
    assert.equal(run.gh.calls.includes("merge"), true);
    assert.ok(urls.every((url) => url.startsWith(PREVIEW)));
    assert.equal(urls.some((url) => url.includes("vercel.com/")), false);
  });

  it("does not merge a green repro it has not tried to fix", async () => {
    const run = harness({ fetchImpl: quoteFetch(SHA) });
    await run.run();
    assert.equal(run.gh.calls.includes("merge"), false);
    assert.equal(run.launches.length, 0);
  });

  it("merges when origin/main is merged in and the repro test blob is unchanged", async () => {
    const run = harness({
      pull: pull({ sha: NEXT }),
      record: { attempts: 1, reproSha: SHA, agentId: null },
      fetchImpl: quoteFetch(NEXT),
      github: {
        async compareFiles(_base, head) {
          if (head === SHA) {
            return [
              { path: "lib/pricing.test.ts", sha: "blob-repro", status: "added" },
              { path: "e2e/quote.spec.ts", sha: "blob-old", status: "modified" },
            ];
          }
          return [
            { path: "lib/pricing.test.ts", sha: "blob-repro", status: "added" },
            { path: "lib/pricing.ts", sha: "blob-fix", status: "modified" },
          ];
        },
      },
    });
    await run.run();
    assert.equal(run.gh.calls.includes("merge"), true);
    assert.equal(run.store.record()?.phase, "merged");
  });

  it("stops when a protected workflow file changes", async () => {
    const run = harness({
      pull: pull({ sha: NEXT }),
      record: { attempts: 1, reproSha: SHA },
      fetchImpl: quoteFetch(NEXT),
      github: {
        async compareFiles(_base, head) {
          if (head === SHA) {
            return [{ path: "lib/pricing.test.ts", sha: "blob-repro", status: "added" }];
          }
          return [
            { path: "lib/pricing.test.ts", sha: "blob-repro", status: "added" },
            { path: ".github/workflows/ci.yml", sha: "blob-wf", status: "modified" },
          ];
        },
      },
    });
    await run.run();
    assert.equal(run.gh.calls.includes("merge"), false);
    assert.equal(run.store.record()?.phase, "stopped");
    assert.match(run.gh.comments[0] ?? "", /ci\.yml/);
  });

  it("does not stop when a 409 means the head moved", async () => {
    const run = harness({
      record: { attempts: 1, reproSha: SHA },
      fetchImpl: quoteFetch(SHA),
      github: {
        async merge() {
          throw Object.assign(new Error("head moved"), { status: 409 });
        },
        async getPull(number) {
          return pull({ number, sha: NEXT, merged: false });
        },
      },
    });
    await run.run();
    assert.equal(run.gh.comments.length, 0);
    assert.equal(run.store.record()?.phase, "active");
  });

  it("does not launch when the cloud agent status is unknown", async () => {
    const run = harness({
      record: { attempts: 1, agentId: "bc-attempt-1", attemptSha: SHA, reproSha: SHA },
      agent: { status: "unknown" },
    });
    await run.run();
    assert.equal(run.launches.length, 0);
    assert.equal(run.gh.calls.includes("listCheckRuns"), false);
  });

  it("stops once when the same head has been pending for more than 30 minutes", async () => {
    const run = harness({
      record: {
        attempts: 1,
        reproSha: SHA,
        pendingSince: { sha: SHA, at: new Date(Date.now() - 31 * 60 * 1000).toISOString() },
      },
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "Protected deployment" } }), { status: 401 })) as typeof fetch,
    });
    await run.run();
    assert.equal(run.gh.comments.length, 1);
    assert.match(run.gh.comments[0] ?? "", /VERCEL_AUTOMATION_BYPASS_SECRET/);
    assert.equal(run.store.record()?.phase, "stopped");
    assert.equal(run.launches.length, 0);
  });

  it("does not merge when the preview redirects", async () => {
    const run = harness({
      fetchImpl: (async (_input, init) => {
        assert.equal(init?.redirect, "manual");
        return new Response(null, { status: 302, headers: { location: "https://vercel.com/login" } });
      }) as typeof fetch,
    });
    await run.run();
    assert.equal(run.gh.calls.includes("merge"), false);
    assert.equal(run.launches.length, 1);
  });

  it("returns null from the comment hook", () => {
    const options = getGitHubChannelOptions(channel);
    assert.equal(options?.onComment?.({} as never, {} as never), null);
  });
});
