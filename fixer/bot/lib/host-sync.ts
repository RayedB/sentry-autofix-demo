import type { JsonValue } from "@grok/agent-sdk";
import { clientFrom, type RepoClient } from "./github-api.js";
import { launchRecord } from "./launch-call.js";
import { verifyPreviewQuote } from "./preview.js";
import { isReproPull } from "./repro.js";
import type { ToolCaller } from "./runtime.js";
import { syncPull, type Kv, type Observation, type SyncDeps } from "./sync.js";

const EMPTY: Observation = { ci: "pending", previewState: "none", previewUrl: null, detail: "" };

type HostKv = {
  get(key: string): Promise<JsonValue | undefined>;
  put(key: string, value: JsonValue): Promise<void>;
};

export async function syncNumber(input: {
  getOctokit: () => Promise<unknown>;
  kv: HostKv;
  callTool: ToolCaller;
  number: number;
}): Promise<void> {
  const client = await clientFrom(input.getOctokit);
  const deps = depsFor(client, input.kv, input.callTool);
  const pull = await client.getPull(input.number);
  if (pull === null) {
    return;
  }
  if (!pull.open || pull.merged) {
    await syncPull(deps, pull, EMPTY);
    return;
  }
  if (!isReproPull({ ref: pull.branch, body: pull.body, labels: pull.labels })) {
    return;
  }
  await syncPull(deps, pull, await client.observe(pull));
}

export async function syncOpen(input: {
  getOctokit: () => Promise<unknown>;
  kv: HostKv;
  callTool: ToolCaller;
}): Promise<void> {
  const client = await clientFrom(input.getOctokit);
  const deps = depsFor(client, input.kv, input.callTool);
  const pulls = await client.listOpenPulls();
  for (const pull of pulls) {
    if (!isReproPull({ ref: pull.branch, body: pull.body, labels: pull.labels })) {
      continue;
    }
    await syncPull(deps, pull, await client.observe(pull));
  }
}

export async function syncBySha(input: {
  getOctokit: () => Promise<unknown>;
  kv: HostKv;
  callTool: ToolCaller;
  sha: string;
}): Promise<void> {
  const client = await clientFrom(input.getOctokit);
  const pulls = await client.listOpenPulls();
  const pull = pulls.find((item) => item.sha === input.sha);
  if (pull === undefined) {
    return;
  }
  await syncNumber({ ...input, number: pull.number });
}

function depsFor(client: RepoClient, kv: HostKv, callTool: ToolCaller): SyncDeps {
  return {
    kv: adaptKv(kv),
    probe: (url) => verifyPreviewQuote(url),
    launch: (record) => launchRecord(callTool, record),
    comment: (number, body) => client.comment(number, body),
    merge: (number, sha) => client.squashMerge(number, sha),
  };
}

function adaptKv(kv: HostKv): Kv {
  return {
    get: (key) => kv.get(key),
    put: (key, value) => kv.put(key, value as JsonValue),
  };
}
