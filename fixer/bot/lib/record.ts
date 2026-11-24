import type { JsonValue } from "@grok/agent-sdk";
import { isRecord, readNumber, readString } from "./json.js";

export type FixPhase = "active" | "merged" | "stopped";

export type PendingSince = { sha: string; at: string };

export type FixRecord = {
  prNumber: number;
  reproSha: string;
  attempts: number;
  agentId: string | null;
  /** Head SHA the current cloud-agent attempt was launched against. */
  attemptSha: string | null;
  lastFailure: string | null;
  pendingSince: PendingSince | null;
  phase: FixPhase;
};

export function runKey(prNumber: number): string {
  return `fixer:run:${prNumber}`;
}

export function parseFixRecord(value: unknown): FixRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const prNumber = readNumber(value, "prNumber");
  const reproSha = readString(value, "reproSha");
  const attempts = readNumber(value, "attempts");
  const phase = readString(value, "phase");
  if (
    prNumber === null ||
    !Number.isInteger(prNumber) ||
    reproSha === null ||
    attempts === null ||
    !Number.isInteger(attempts) ||
    (phase !== "active" && phase !== "merged" && phase !== "stopped")
  ) {
    return null;
  }
  return {
    prNumber,
    reproSha,
    attempts,
    agentId: readString(value, "agentId"),
    attemptSha: readString(value, "attemptSha"),
    lastFailure: typeof value.lastFailure === "string" ? value.lastFailure : null,
    pendingSince: pendingSince(value.pendingSince),
    phase,
  };
}

function pendingSince(value: unknown): PendingSince | null {
  if (!isRecord(value)) {
    return null;
  }
  const sha = readString(value, "sha");
  const at = readString(value, "at");
  if (sha === null || at === null) {
    return null;
  }
  return { sha, at };
}

export function toJson(record: FixRecord): JsonValue {
  return {
    prNumber: record.prNumber,
    reproSha: record.reproSha,
    attempts: record.attempts,
    agentId: record.agentId,
    attemptSha: record.attemptSha,
    lastFailure: record.lastFailure,
    pendingSince: record.pendingSince,
    phase: record.phase,
  };
}
