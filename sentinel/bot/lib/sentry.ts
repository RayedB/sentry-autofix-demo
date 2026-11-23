import { isRecord, readString } from "./json.js";

export const SENTRY_API_ORIGIN = "https://us.sentry.io";
export const SENTRY_CLIENT_SECRET_NAME = "SENTRY_CLIENT_SECRET";
export const SENTRY_API_TOKEN_NAME = "SENTRY_API_TOKEN";

const ISSUE_ID = /^[0-9]{1,32}$/;

export type InAppFrame = {
  filename: string | null;
  lineNo: number | null;
  contextLine: string | null;
  functionName: string | null;
  vars: Record<string, string> | null;
};

export type SentryIssueSnapshot = {
  id: string;
  title: string | null;
  culprit: string | null;
  permalink: string | null;
  shortId: string | null;
  status: string | null;
  project: string | null;
  release: string | null;
  exception: string | null;
  requestPath: string | null;
  inAppFrames: InAppFrame[];
};

export function assertIssueId(issueId: string): string {
  if (!ISSUE_ID.test(issueId)) {
    throw new Error("issueId must be the numeric Sentry issue id.");
  }
  return issueId;
}

export async function fetchSentryIssue(issueId: string, token: string): Promise<SentryIssueSnapshot> {
  const id = assertIssueId(issueId);
  const [issue, event] = await Promise.all([
    sentryGet(`/issues/${id}/`, token),
    sentryGet(`/issues/${id}/events/latest/`, token),
  ]);
  return {
    id,
    title: readString(issue, "title"),
    culprit: readString(issue, "culprit") ?? readString(event, "culprit"),
    permalink: readString(issue, "permalink"),
    shortId: readString(issue, "shortId"),
    status: readString(issue, "status"),
    project: projectSlug(issue),
    release: releaseOf(event) ?? releaseOf(issue),
    exception: exceptionSummary(event),
    requestPath: requestPath(event),
    inAppFrames: inAppFrames(event),
  };
}

async function sentryGet(path: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${SENTRY_API_ORIGIN}/api/0${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Sentry API ${path} returned ${response.status}.`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body)) {
    throw new Error(`Sentry API ${path} did not return an object.`);
  }
  return body;
}

function projectSlug(issue: Record<string, unknown>): string | null {
  const project = issue.project;
  if (!isRecord(project)) {
    return null;
  }
  return readString(project, "slug");
}

function releaseOf(record: Record<string, unknown>): string | null {
  const release = record.release;
  if (typeof release === "string") {
    return release.trim() === "" ? null : release;
  }
  if (!isRecord(release)) {
    return null;
  }
  return readString(release, "version");
}

function exceptionSummary(event: Record<string, unknown>): string | null {
  const value = firstException(event);
  if (value === undefined) {
    return null;
  }
  const type = readString(value, "type");
  const message = readString(value, "value");
  if (type !== null && message !== null) {
    return `${type}: ${message}`;
  }
  return type ?? message;
}

function requestPath(event: Record<string, unknown>): string | null {
  const direct = requestUrl(event.request);
  if (direct !== null) {
    return pathOf(direct);
  }
  for (const entry of entries(event)) {
    if (readString(entry, "type") !== "request") {
      continue;
    }
    const url = requestUrl(entry.data);
    if (url !== null) {
      return pathOf(url);
    }
  }
  return null;
}

function requestUrl(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return readString(value, "url");
}

function pathOf(url: string): string {
  if (url.startsWith("/")) {
    return url.split("?")[0] ?? url;
  }
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function inAppFrames(event: Record<string, unknown>): InAppFrame[] {
  const frames: InAppFrame[] = [];
  for (const value of exceptionValues(event)) {
    const stack = value.stacktrace;
    if (!isRecord(stack) || !Array.isArray(stack.frames)) {
      continue;
    }
    for (const frame of stack.frames) {
      const normalized = normalizeFrame(frame);
      if (normalized !== null) {
        frames.push(normalized);
      }
    }
  }
  return frames.slice(-20);
}

function exceptionValues(event: Record<string, unknown>): Record<string, unknown>[] {
  const direct = firstExceptionList(event.exception);
  if (direct.length > 0) {
    return direct;
  }
  const fromEntries: Record<string, unknown>[] = [];
  for (const entry of entries(event)) {
    if (readString(entry, "type") !== "exception") {
      continue;
    }
    fromEntries.push(...firstExceptionList(entry.data));
  }
  return fromEntries;
}

function firstException(event: Record<string, unknown>): Record<string, unknown> | undefined {
  return exceptionValues(event)[0];
}

function firstExceptionList(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.values)) {
    return [];
  }
  return value.values.filter(isRecord);
}

function entries(event: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(event.entries)) {
    return [];
  }
  return event.entries.filter(isRecord);
}

function normalizeFrame(value: unknown): InAppFrame | null {
  if (!isRecord(value) || !frameInApp(value)) {
    return null;
  }
  return {
    filename: readString(value, "filename"),
    lineNo: lineNumber(value),
    contextLine: contextLine(value),
    functionName: readString(value, "function"),
    vars: frameVars(value.vars),
  };
}

function frameInApp(frame: Record<string, unknown>): boolean {
  if (typeof frame.inApp === "boolean") {
    return frame.inApp;
  }
  if (typeof frame.in_app === "boolean") {
    return frame.in_app;
  }
  return false;
}

function lineNumber(frame: Record<string, unknown>): number | null {
  const camel = frame.lineNo;
  if (typeof camel === "number" && Number.isInteger(camel)) {
    return camel;
  }
  const snake = frame.lineno;
  if (typeof snake === "number" && Number.isInteger(snake)) {
    return snake;
  }
  return null;
}

function contextLine(frame: Record<string, unknown>): string | null {
  const direct = readString(frame, "contextLine") ?? readString(frame, "context_line");
  if (direct !== null) {
    return direct;
  }
  const lineNo = lineNumber(frame);
  const context = frame.context;
  if (lineNo === null || !Array.isArray(context)) {
    return null;
  }
  for (const row of context) {
    if (!Array.isArray(row) || row.length < 2) {
      continue;
    }
    if (row[0] === lineNo && typeof row[1] === "string") {
      return row[1];
    }
  }
  return null;
}

function frameVars(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }
  const vars: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= 20) {
      break;
    }
    vars[key] = stringifyVar(raw).slice(0, 200);
    count += 1;
  }
  return count === 0 ? null : vars;
}

function stringifyVar(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
