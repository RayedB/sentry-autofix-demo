import type { JsonObject } from "@grok/agent-sdk";
import * as z from "zod/v4";
import { GITHUB_OWNER, GITHUB_REPO } from "./github.js";
import { isSafeTestPath, parseAgentReplay, replayToJson, type ReplaySpec } from "./replay.js";

const ISSUE_ID = /^[0-9]{1,32}$/;
const issueId = z.string().regex(ISSUE_ID);
const positive = z.number().int().positive();
const issueLinkSchema = z.object({
  sentryIssueId: issueId,
  githubIssueNumber: positive,
  replay: z.unknown().optional().nullable(),
});
const prLinkSchema = issueLinkSchema.extend({
  prNumber: positive,
  testPath: z.string().optional().nullable(),
});
const memorySchema = z.object({
  issueId,
  acceptedAt: z.string().min(1),
  replay: z.unknown().optional().nullable(),
});
const REFS = /(?:^|\s)Refs\s+#(\d+)\b/;
const SENTRY_ISSUE = /\/issues\/([0-9]{1,32})(?!\d)/;

export type IssueLink = {
  sentryIssueId: string;
  githubIssueNumber: number;
  replay: ReplaySpec | null;
};

export type PrLink = {
  sentryIssueId: string;
  githubIssueNumber: number;
  prNumber: number;
  testPath: string | null;
  replay: ReplaySpec | null;
};

export type SentryIssueMemory = {
  issueId: string;
  acceptedAt: string;
  replay: ReplaySpec | null;
};

export function sentryIssueKey(issueId: string): string {
  return `sentry:issue:${issueId}`;
}

export function issueLinkKey(issueNumber: number): string {
  return `sentinel:link:issue:${issueNumber}`;
}

export function prLinkKey(prNumber: number): string {
  return `sentinel:link:pr:${prNumber}`;
}

export function sentryIssueIdFromContinuation(key: string | null | undefined): string | null {
  if (key === undefined || key === null) {
    return null;
  }
  const match = /^sentry:issue:([0-9]{1,32})$/.exec(key);
  return match?.[1] ?? null;
}

export function prNumberFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
      return null;
    }
    const match = new RegExp(`^/${GITHUB_OWNER}/${GITHUB_REPO}/pull/(\\d+)/?$`).exec(parsed.pathname);
    if (match?.[1] === undefined) {
      return null;
    }
    return positiveInt(Number(match[1]));
  } catch {
    return null;
  }
}

export function refsIssueNumber(text: string | null): number | null {
  if (text === null) {
    return null;
  }
  const match = REFS.exec(text);
  if (match?.[1] === undefined) {
    return null;
  }
  return positiveInt(Number(match[1]));
}

export function sentryIssueIdFromText(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const match = SENTRY_ISSUE.exec(text);
  const id = match?.[1];
  if (id === undefined || !ISSUE_ID.test(id)) {
    return null;
  }
  return id;
}

export function parseSentryIssueMemory(value: unknown): SentryIssueMemory | null {
  const parsed = memorySchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return { issueId: parsed.data.issueId, acceptedAt: parsed.data.acceptedAt, replay: optionalReplay(parsed.data.replay) };
}

export function parseIssueLink(value: unknown): IssueLink | null {
  const parsed = issueLinkSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return {
    sentryIssueId: parsed.data.sentryIssueId,
    githubIssueNumber: parsed.data.githubIssueNumber,
    replay: optionalReplay(parsed.data.replay),
  };
}

export function parsePrLink(value: unknown): PrLink | null {
  const parsed = prLinkSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const testPath = parsed.data.testPath;
  return {
    sentryIssueId: parsed.data.sentryIssueId,
    githubIssueNumber: parsed.data.githubIssueNumber,
    prNumber: parsed.data.prNumber,
    testPath: testPath != null && isSafeTestPath(testPath) ? testPath : null,
    replay: optionalReplay(parsed.data.replay),
  };
}

export function issueLinkJson(link: IssueLink): JsonObject {
  return {
    sentryIssueId: link.sentryIssueId,
    githubIssueNumber: link.githubIssueNumber,
    ...(link.replay !== null ? { replay: replayToJson(link.replay) } : {}),
  };
}

export function prLinkJson(link: PrLink): JsonObject {
  return {
    sentryIssueId: link.sentryIssueId,
    githubIssueNumber: link.githubIssueNumber,
    prNumber: link.prNumber,
    ...(link.testPath !== null ? { testPath: link.testPath } : {}),
    ...(link.replay !== null ? { replay: replayToJson(link.replay) } : {}),
  };
}

function positiveInt(value: number): number | null {
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function optionalReplay(value: unknown): ReplaySpec | null {
  if (value === undefined || value === null) {
    return null;
  }
  return parseAgentReplay(value);
}
