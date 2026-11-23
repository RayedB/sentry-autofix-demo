import { isRecord, readString } from "./json.js";

const ISSUE_ID = /^[0-9]{1,32}$/;

export type AcceptedAlert = {
  kind: "accept";
  issueId: string;
  title: string;
  message: string;
  snapshot: string;
};

export type AlertDecision = { kind: "ignore" } | AcceptedAlert;

export function readEventAlert(body: unknown, resource: string | null): AlertDecision {
  if (resource !== "event_alert" || !isRecord(body) || body.action !== "triggered") {
    return { kind: "ignore" };
  }
  const data = body.data;
  if (!isRecord(data) || !isRecord(data.event)) {
    return { kind: "ignore" };
  }
  const issueId = issueIdOf(data.event.issue_id);
  if (issueId === null) {
    return { kind: "ignore" };
  }
  const event = data.event;
  const title = readString(event, "title") ?? `Sentry issue ${issueId}`;
  const snapshot = JSON.stringify(snapshotOf(body, event, data, issueId, title));
  return {
    kind: "accept",
    issueId,
    title,
    snapshot,
    message: alertTurnMessage({
      issueId,
      title,
      webUrl: readString(event, "web_url"),
      issueUrl: readString(event, "issue_url"),
      release: releaseText(event.release),
      culprit: readString(event, "culprit"),
      triggeredRule: readString(data, "triggered_rule"),
      frame: suspectedFrame(event),
    }),
  };
}

export function alertTurnMessage(input: {
  issueId: string;
  title: string;
  webUrl: string | null;
  issueUrl: string | null;
  release: string | null;
  culprit: string | null;
  triggeredRule: string | null;
  frame: string | null;
}): string {
  return [
    "Sentry issue alert triggered. Follow the issue-alert procedure in your instructions.",
    "The webhook snapshot is in sentry/event-alert.json.",
    `issue_id: ${input.issueId}`,
    `title: ${input.title}`,
    `web_url: ${input.webUrl ?? ""}`,
    `issue_url: ${input.issueUrl ?? ""}`,
    `release: ${input.release ?? ""}`,
    `culprit: ${input.culprit ?? ""}`,
    `triggered_rule: ${input.triggeredRule ?? ""}`,
    `webhook_frame: ${input.frame ?? ""}`,
  ].join("\n");
}

function issueIdOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value !== "string" || !ISSUE_ID.test(value)) {
    return null;
  }
  return value;
}

function releaseText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value;
  }
  if (!isRecord(value)) {
    return null;
  }
  return readString(value, "version");
}

function suspectedFrame(event: Record<string, unknown>): string | null {
  const exception = event.exception;
  if (!isRecord(exception) || !Array.isArray(exception.values)) {
    return null;
  }
  for (const value of exception.values) {
    if (!isRecord(value)) {
      continue;
    }
    const stack = value.stacktrace;
    if (!isRecord(stack) || !Array.isArray(stack.frames)) {
      continue;
    }
    for (const frame of stack.frames) {
      if (!isRecord(frame) || (frame.in_app !== true && frame.inApp !== true)) {
        continue;
      }
      const filename = readString(frame, "filename");
      const line = frame.lineno ?? frame.lineNo;
      if (filename !== null && typeof line === "number") {
        return `${filename}:${line}`;
      }
    }
  }
  return null;
}

function snapshotOf(
  body: Record<string, unknown>,
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  issueId: string,
  title: string,
): Record<string, unknown> {
  return {
    action: body.action,
    installation: body.installation ?? null,
    actor: body.actor ?? null,
    data: {
      triggered_rule: data.triggered_rule ?? null,
      event: {
        issue_id: issueId,
        title,
        culprit: event.culprit ?? null,
        release: event.release ?? null,
        web_url: event.web_url ?? null,
        issue_url: event.issue_url ?? null,
        url: event.url ?? null,
        event_id: event.event_id ?? null,
        platform: event.platform ?? null,
        datetime: event.datetime ?? null,
        metadata: event.metadata ?? null,
        request: event.request ?? null,
        exception: event.exception ?? null,
        tags: event.tags ?? null,
      },
    },
  };
}
