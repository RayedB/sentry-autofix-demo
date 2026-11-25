import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonValue } from "@grok/agent-sdk";
import { githubFromOctokit } from "./github-rest.js";
import { prLinkKey } from "./links.js";
import { PROD_ORIGIN, type ReplaySpec } from "./replay.js";
import { fetchSentryIssue, listProductionEvents, resolveSentryIssue, SENTRY_ORG } from "./sentry.js";
import {
  parseVerifyRecord,
  verifyKey,
  verifyTick,
  type AgentView,
  type ClosedPull,
  type SentryClient,
  type VerifyRecord,
} from "./verify.js";

const NOW = Date.parse("2026-11-25T15:00:00.000Z");
const MERGE = "a".repeat(40);
const PROD = "b".repeat(40);
const AGENT_URL = "https://cursor.com/agents/bc-1";

const httpReplay: ReplaySpec = {
  kind: "http",
  method: "POST",
  path: "/api/orders",
  contentType: "application/json",
  body: JSON.stringify({ sku: "kenya" }),
  expectStatusMin: 200,
  expectStatusMax: 299,
};

const browserReplay: ReplaySpec = {
  kind: "browser",
  path: "/",
  description: "Quote form shows a delivery label",
  testPath: "e2e/quote.spec.ts",
};

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function pull(overrides: Partial<ClosedPull> = {}): ClosedPull {
  return {
    number: 7,
    merged: true,
    mergedAt: new Date(NOW - 60_000).toISOString(),
    mergeCommitSha: MERGE,
    baseRef: "main",
    headRepoFullName: "RayedB/sentry-autofix-demo",
    labels: ["sentry-repro"],
    body: "Refs #12\n",
    title: "Fix quote",
    htmlUrl: "https://github.com/RayedB/sentry-autofix-demo/pull/7",
    ...overrides,
  };
}

function link(replay: ReplaySpec = httpReplay): JsonValue {
  return asJson({
    sentryIssueId: "42",
    githubIssueNumber: 12,
    prNumber: 7,
    testPath: "e2e/quote.spec.ts",
    replay,
  });
}

function stored(overrides: Partial<VerifyRecord> = {}): VerifyRecord {
  return {
    prNumber: 7,
    phase: "waiting_deploy",
    sentryIssueId: "42",
    githubIssueNumber: 12,
    mergeCommitSha: MERGE,
    mergedAt: new Date(NOW - 60_000).toISOString(),
    prodSha: MERGE,
    replayMode: "http",
    replaySummary: "POST /api/orders returned 200",
    replayedAt: new Date(NOW - 60_000).toISOString(),
    agentId: null,
    agentUrl: null,
    startedAt: null,
    failure: null,
    ...overrides,
  };
}

function harness(
  options: {
    pull?: ClosedPull;
    link?: JsonValue | null;
    record?: VerifyRecord | null;
    prodSha?: string | null;
    compare?: string;
    replayStatus?: number;
    replayBody?: string;
    fetchedReplay?: ReplaySpec | null;
    events?: Array<{ id: string }>;
    issue?: { body: string | null; state: string } | null;
    agent?: AgentView;
    sentry?: SentryClient;
  } = {},
) {
  const values = new Map<string, JsonValue>();
  const kvGets: string[] = [];
  if (options.link) {
    values.set(prLinkKey(7), options.link);
  }
  if (options.record) {
    values.set(verifyKey(7), asJson(options.record));
  }
  const githubCalls: string[] = [];
  const comments: Array<{ number: number; body: string }> = [];
  const closed: number[] = [];
  const fetches: Array<{ url: string; method: string; redirect?: RequestRedirect; body?: string }> = [];
  const sentryCalls: string[] = [];
  const launches: Array<{ path: string; description: string; testPath: string | null; prodSha: string }> = [];
  const live = {
    agent: options.agent ?? { status: "finished", result: '{"passed":true,"summary":"ok"}', url: AGENT_URL },
    events: options.events ?? [],
    agentReads: 0,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    fetches.push({
      url,
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url.endsWith("/api/version")) {
      return Response.json({ sha: options.prodSha === undefined ? MERGE : options.prodSha });
    }
    return new Response(options.replayBody ?? "ok", { status: options.replayStatus ?? 200 });
  };
  return {
    kvGets,
    githubCalls,
    comments,
    closed,
    fetches,
    sentryCalls,
    launches,
    live,
    record(): VerifyRecord | null {
      return parseVerifyRecord(values.get(verifyKey(7)));
    },
    async run() {
      await verifyTick(
        {
          kv: {
            async get(key) {
              kvGets.push(key);
              return values.get(key);
            },
            async put(key, value) {
              values.set(key, value);
            },
          },
          github: {
            async compareStatus(base, head) {
              githubCalls.push(`compare:${base}...${head}`);
              return options.compare ?? "behind";
            },
            async comment(number, body) {
              githubCalls.push(`comment:${number}`);
              comments.push({ number, body });
            },
            async getIssue(number) {
              githubCalls.push(`getIssue:${number}`);
              return options.issue === undefined
                ? { body: "Sentry: https://eurodelices.sentry.io/issues/42/events/abc/", state: "open" }
                : options.issue;
            },
            async closeIssue(number) {
              githubCalls.push(`close:${number}`);
              closed.push(number);
            },
          },
          async getAgent() {
            live.agentReads += 1;
            return live.agent;
          },
          async launch(input) {
            launches.push({
              path: input.path,
              description: input.description,
              testPath: input.testPath,
              prodSha: input.prodSha,
            });
            return { agentId: "bc-11111111-1111-1111-1111-111111111111", url: AGENT_URL };
          },
          sentry: options.sentry ?? {
            async fetchIssue() {
              sentryCalls.push("fetch");
              return { replay: options.fetchedReplay ?? null };
            },
            async listProductionEvents() {
              sentryCalls.push("list");
              return live.events;
            },
            async resolveIssue() {
              sentryCalls.push("resolve");
            },
          },
          fetchImpl,
          now: () => NOW,
        },
        options.pull ?? pull(),
      );
    },
  };
}

describe("verifyTick", () => {
  it("ignores fork, non-main, unmerged, and non-repro pulls with no extra calls", async () => {
    const variants = [
      pull({ headRepoFullName: "other/fork" }),
      pull({ headRepoFullName: null }),
      pull({ baseRef: "develop" }),
      pull({ merged: false, mergedAt: null, mergeCommitSha: null }),
      pull({ labels: [], body: "no link here", title: "chore" }),
    ];
    for (const variant of variants) {
      const run = harness({ pull: variant, link: link() });
      await run.run();
      assert.equal(run.record(), null);
      assert.deepEqual(run.kvGets, []);
      assert.deepEqual(run.githubCalls, []);
      assert.deepEqual(run.fetches, []);
      assert.deepEqual(run.sentryCalls, []);
      assert.equal(run.launches.length, 0);
    }
  });

  it("short-circuits terminal records with zero API calls", async () => {
    for (const phase of ["resolved", "failed"] as const) {
      const run = harness({ link: link(), record: stored({ phase, failure: phase === "failed" ? "earlier" : null }) });
      await run.run();
      assert.equal(run.record()?.phase, phase);
      assert.deepEqual(run.githubCalls, []);
      assert.deepEqual(run.fetches, []);
      assert.deepEqual(run.sentryCalls, []);
      assert.equal(run.live.agentReads, 0);
      assert.equal(run.launches.length, 0);
      assert.deepEqual(run.kvGets, [verifyKey(7)]);
    }
  });

  it("stays waiting while production is behind the merge and proceeds when production is ahead", async () => {
    const behind = harness({ link: link(), prodSha: PROD, compare: "behind" });
    await behind.run();
    assert.equal(behind.record()?.phase, "waiting_deploy");
    assert.deepEqual(behind.comments, []);
    assert.deepEqual(behind.sentryCalls, []);
    assert.deepEqual(behind.githubCalls, [`compare:${MERGE}...${PROD}`]);
    assert.ok(behind.fetches.every((call) => call.url.endsWith("/api/version")));

    const ahead = harness({ link: link(), prodSha: PROD, compare: "ahead" });
    await ahead.run();
    assert.equal(ahead.record()?.phase, "replayed");
    assert.equal(ahead.record()?.prodSha, PROD);
    assert.equal(ahead.record()?.replayMode, "http");
    assert.deepEqual(ahead.sentryCalls, []);
    const replay = ahead.fetches.find((call) => call.url === `${PROD_ORIGIN}/api/orders`);
    assert.equal(replay?.method, "POST");
    assert.equal(replay?.redirect, "manual");
    assert.equal(replay?.body, JSON.stringify({ sku: "kenya" }));
  });

  it("fails an HTTP 500 without resolving Sentry", async () => {
    const run = harness({ link: link(), prodSha: MERGE, replayStatus: 500, replayBody: "nope" });
    await run.run();
    assert.equal(run.record()?.phase, "failed");
    assert.match(run.record()?.failure ?? "", /500/);
    assert.deepEqual(run.sentryCalls, []);
    assert.equal(run.githubCalls.includes("compare:" + MERGE + "..." + MERGE), false);
    assert.ok(run.comments.some((comment) => comment.number === 7 && comment.body.includes("was not resolved")));
    assert.ok(run.comments.some((comment) => comment.number === 12 && comment.body.includes("500")));
  });

  it("resolves after a clean HTTP replay and ignores preview events", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const sentryFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "PUT") {
        return new Response("{}", { status: 200 });
      }
      return Response.json([
        {
          eventID: "preview-1",
          dateCreated: new Date(NOW + 1_000).toISOString(),
          tags: [
            { key: "environment", value: "preview" },
            { key: "release", value: MERGE },
          ],
        },
        {
          eventID: "old-prod",
          dateCreated: new Date(NOW - 3_600_000).toISOString(),
          tags: [
            { key: "environment", value: "production" },
            { key: "release", value: "c".repeat(40) },
          ],
        },
      ]);
    };
    const run = harness({
      link: link(),
      prodSha: MERGE,
      sentry: {
        async fetchIssue() {
          throw new Error("sentry issue should not be fetched when the link has a replay");
        },
        listProductionEvents: (issueId, sinceIso, prodSha) => listProductionEvents(issueId, sinceIso, prodSha, "token", sentryFetch),
        resolveIssue: (issueId) => resolveSentryIssue(issueId, "token", sentryFetch),
      },
    });
    await run.run();
    assert.equal(run.record()?.phase, "replayed");
    assert.equal(requests.length, 0);

    await run.run();
    assert.equal(run.record()?.phase, "resolved");
    assert.ok(requests.some((request) => request.url.includes(`/organizations/${SENTRY_ORG}/issues/42/events/?environment=production`)));
    const put = requests.find((request) => request.method === "PUT");
    assert.equal(put?.body, JSON.stringify({ status: "resolved" }));
    assert.match(put?.url ?? "", /\/organizations\/eurodelices\/issues\/42\/$/);
    assert.ok(run.comments.some((comment) => comment.number === 7 && comment.body.includes("New production Sentry events: 0")));
    assert.ok(run.comments.some((comment) => comment.number === 12 && comment.body.includes("Sentry issue 42 resolved.")));
    assert.deepEqual(run.closed, [12]);
  });

  it("fails when a new production event arrives after the replay", async () => {
    const run = harness({
      record: stored({ phase: "replayed", replayedAt: new Date(NOW - 60_000).toISOString() }),
      events: [{ id: "prod-new" }],
    });
    await run.run();
    assert.equal(run.record()?.phase, "failed");
    assert.match(run.record()?.failure ?? "", /prod-new/);
    assert.deepEqual(run.sentryCalls, ["list"]);
    assert.equal(run.sentryCalls.includes("resolve"), false);
    assert.ok(run.comments.some((comment) => comment.body.includes("prod-new") && comment.body.includes("was not resolved")));
    assert.equal(run.fetches.length, 0);
  });

  it("launches a browser check, waits, then resolves on pass and fails on a bad result", async () => {
    const passed = harness({ link: link(browserReplay), prodSha: MERGE, agent: { status: "running", url: AGENT_URL } });
    await passed.run();
    assert.equal(passed.record()?.phase, "verifying_browser");
    assert.equal(passed.launches.length, 1);
    assert.equal(passed.launches[0]?.path, "/");
    assert.equal(passed.launches[0]?.testPath, "e2e/quote.spec.ts");
    assert.equal(passed.launches[0]?.prodSha, MERGE);
    assert.deepEqual(passed.sentryCalls, []);

    await passed.run();
    assert.equal(passed.record()?.phase, "verifying_browser");
    assert.equal(passed.launches.length, 1);
    assert.equal(passed.live.agentReads, 1);

    passed.live.agent = { status: "finished", result: '{"passed":true,"summary":"quote form is quiet"}', url: AGENT_URL };
    await passed.run();
    assert.equal(passed.record()?.phase, "replayed");
    assert.equal(passed.record()?.replayMode, "browser");
    assert.equal(passed.record()?.replaySummary, "quote form is quiet");
    assert.deepEqual(passed.sentryCalls, []);

    await passed.run();
    assert.equal(passed.record()?.phase, "resolved");
    assert.deepEqual(passed.sentryCalls, ["list", "resolve"]);
    assert.deepEqual(passed.closed, [12]);

    const failed = harness({ link: link(browserReplay), prodSha: MERGE, agent: { status: "running" } });
    await failed.run();
    failed.live.agent = { status: "error", result: '{"passed":false,"summary":"pageerror: boom"}', url: AGENT_URL };
    await failed.run();
    assert.equal(failed.record()?.phase, "failed");
    assert.match(failed.record()?.failure ?? "", /pageerror: boom/);
    assert.match(failed.comments.map((comment) => comment.body).join("\n"), /cursor.com\/agents\/bc-1/);
    assert.deepEqual(failed.sentryCalls, []);

    const invalid = harness({
      record: stored({
        phase: "verifying_browser",
        agentId: "bc-1",
        agentUrl: AGENT_URL,
        startedAt: new Date(NOW - 60_000).toISOString(),
        replayMode: "browser",
      }),
      agent: { status: "finished", result: "not json", url: AGENT_URL },
    });
    await invalid.run();
    assert.equal(invalid.record()?.phase, "failed");
    assert.match(invalid.record()?.failure ?? "", /did not return JSON/);
    assert.deepEqual(invalid.sentryCalls, []);
  });

  it("fails closed when no replay spec can be derived", async () => {
    const run = harness({ pull: pull({ body: "fixed the bug", title: "Fix quote" }) });
    await run.run();
    assert.equal(run.record()?.phase, "failed");
    assert.match(run.record()?.failure ?? "", /No safe production replay descriptor/);
    assert.equal(run.fetches.length, 0);
    assert.deepEqual(run.sentryCalls, []);
    assert.equal(run.githubCalls.includes("getIssue:12"), false);
    assert.ok(run.comments.some((comment) => comment.number === 7 && comment.body.includes("was not resolved")));
  });

  it("fails a deploy wait that exceeds 30 minutes", async () => {
    const mergedAt = new Date(NOW - 31 * 60 * 1000).toISOString();
    const run = harness({ link: link(), pull: pull({ mergedAt }) });
    await run.run();
    assert.equal(run.record()?.phase, "failed");
    assert.match(run.record()?.failure ?? "", /30 minutes/);
    assert.equal(run.fetches.length, 0);
    assert.deepEqual(run.sentryCalls, []);
    assert.ok(run.comments.some((comment) => comment.number === 7));
    assert.ok(run.comments.some((comment) => comment.number === 12));
  });

  it("drops a merged pull older than 24 hours unless verification is already in progress", async () => {
    const mergedAt = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
    const fresh = harness({ link: link(), pull: pull({ mergedAt }) });
    await fresh.run();
    assert.equal(fresh.record(), null);
    assert.equal(fresh.fetches.length, 0);
    assert.deepEqual(fresh.githubCalls, []);

    const tracked = harness({
      link: link(),
      pull: pull({ mergedAt }),
      record: stored({ phase: "waiting_deploy", mergedAt, prodSha: null, replaySummary: null, replayedAt: null }),
    });
    await tracked.run();
    assert.equal(tracked.record()?.phase, "failed");
    assert.match(tracked.record()?.failure ?? "", /30 minutes/);
  });

  it("recovers a missing pull link from Refs and the GitHub issue body", async () => {
    const run = harness({
      pull: pull({ labels: [], body: "Refs #12\n", title: "repro" }),
      prodSha: MERGE,
      fetchedReplay: httpReplay,
    });
    await run.run();
    assert.equal(run.record()?.phase, "replayed");
    assert.equal(run.record()?.sentryIssueId, "42");
    assert.ok(run.githubCalls.includes("getIssue:12"));
    assert.deepEqual(run.sentryCalls, ["fetch"]);
  });

  it("times out a browser agent that is still running after 15 minutes", async () => {
    const run = harness({
      record: stored({
        phase: "verifying_browser",
        agentId: "bc-1",
        agentUrl: AGENT_URL,
        startedAt: new Date(NOW - 16 * 60 * 1000).toISOString(),
        replayMode: "browser",
        replaySummary: null,
        replayedAt: null,
      }),
      agent: { status: "running", url: AGENT_URL },
    });
    await run.run();
    assert.equal(run.record()?.phase, "failed");
    assert.match(run.record()?.failure ?? "", /15 minutes/);
    assert.equal(run.live.agentReads, 1);
    assert.deepEqual(run.sentryCalls, []);
  });
});

describe("sentry production events", () => {
  it("keeps production events for this deploy and drops preview events", async () => {
    const since = new Date(NOW).toISOString();
    let seen = "";
    const events = await listProductionEvents("42", since, PROD, "token", async (input) => {
      seen = String(input);
      return Response.json([
        {
          eventID: "preview-1",
          dateCreated: new Date(NOW).toISOString(),
          tags: [
            { key: "environment", value: "preview" },
            { key: "release", value: PROD },
          ],
        },
        {
          eventID: "old-prod",
          dateCreated: new Date(NOW - 60_000).toISOString(),
          tags: [
            { key: "environment", value: "production" },
            { key: "release", value: "c".repeat(40) },
          ],
        },
        { eventID: "skew", dateCreated: new Date(NOW - 4_000).toISOString(), tags: [{ key: "environment", value: "production" }] },
        {
          eventID: "too-old",
          dateCreated: new Date(NOW - 6_000).toISOString(),
          tags: [
            { key: "environment", value: "production" },
            { key: "release", value: "other" },
          ],
        },
        {
          eventID: "same-sha",
          dateCreated: new Date(NOW - 3_600_000).toISOString(),
          tags: [
            { key: "environment", value: "production" },
            { key: "release", value: PROD },
          ],
        },
        { id: "field-env", environment: "production", dateCreated: new Date(NOW).toISOString(), release: "other" },
      ]);
    });
    assert.match(seen, /\/api\/0\/organizations\/eurodelices\/issues\/42\/events\/\?environment=production&statsPeriod=1h&per_page=25$/);
    assert.deepEqual(
      events.map((event) => event.id),
      ["skew", "same-sha", "field-env"],
    );
  });

  it("reads the org-scoped issue and derives replay from http_replay", async () => {
    const urls: string[] = [];
    const snap = await fetchSentryIssue("42", "token", async (input) => {
      urls.push(String(input));
      if (String(input).endsWith("/events/latest/")) {
        return Response.json({
          title: "Boom",
          platform: "node",
          contexts: { http_replay: { method: "POST", path: "/api/from-context", body: { sku: "kenya" } } },
          request: {
            method: "POST",
            url: `${PROD_ORIGIN}/api/from-request`,
            data: { sku: "kenya" },
            headers: [["User-Agent", "x"]],
          },
        });
      }
      return Response.json({ title: "Issue" });
    });
    assert.equal(snap.replay?.kind, "http");
    if (snap.replay?.kind === "http") {
      assert.equal(snap.replay.path, "/api/from-context");
    }
    assert.equal(snap.request?.url, `${PROD_ORIGIN}/api/from-request`);
    assert.equal(snap.httpReplay?.path, "/api/from-context");
    assert.ok(urls.every((url) => url.includes(`/api/0/organizations/${SENTRY_ORG}/issues/42/`)));
  });

  it("names the event:write permission when resolve is forbidden", async () => {
    const denied: typeof fetch = async (_input, init) => new Response("no", { status: init?.method === "PUT" ? 403 : 200 });
    await assert.rejects(() => resolveSentryIssue("42", "token", denied), /Issue & Event: Read & Write \(event:write\)/);
    const unauthorized: typeof fetch = async () => new Response("no", { status: 401 });
    await assert.rejects(() => resolveSentryIssue("42", "token", unauthorized), /event:write/);
  });
});

describe("githubFromOctokit", () => {
  it("lists the 20 newest closed main pulls and closes an issue as completed", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const lists: Array<Record<string, unknown>> = [];
    const github = githubFromOctokit({
      rest: {
        pulls: {
          list: async (params: Record<string, unknown>) => {
            lists.push(params);
            return {
              data: [
                {
                  number: 9,
                  html_url: "https://github.com/RayedB/sentry-autofix-demo/pull/9",
                  merged_at: "2026-11-25T14:00:00Z",
                  merge_commit_sha: MERGE,
                  base: { ref: "main" },
                  head: { repo: { full_name: "other/fork" } },
                  labels: [{ name: "sentry-repro" }],
                  body: "Refs #3",
                  title: "fork",
                },
              ],
            };
          },
        },
        repos: {
          compareCommitsWithBasehead: async () => ({ data: { status: "ahead" } }),
        },
        issues: {
          createComment: async () => ({ data: {} }),
          get: async () => ({ data: { body: "Sentry: https://eurodelices.sentry.io/issues/42/", state: "open" } }),
          update: async (params: Record<string, unknown>) => {
            updates.push(params);
            return { data: {} };
          },
        },
      },
    });
    const pulls = await github.listRecentClosedPulls();
    assert.equal(pulls[0]?.headRepoFullName, "other/fork");
    assert.equal(pulls[0]?.merged, true);
    assert.equal(pulls[0]?.mergeCommitSha, MERGE);
    assert.equal(lists[0]?.per_page, 20);
    assert.equal(lists[0]?.base, "main");
    assert.equal(lists[0]?.state, "closed");
    assert.equal(lists[0]?.sort, "updated");
    assert.equal(lists[0]?.direction, "desc");
    await github.closeIssue(3);
    assert.equal(updates[0]?.state, "closed");
    assert.equal(updates[0]?.state_reason, "completed");
    assert.equal(await github.compareStatus(MERGE, PROD), "ahead");
  });
});
