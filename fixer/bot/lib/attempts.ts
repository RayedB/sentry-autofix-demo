export const MAX_FIX_ATTEMPTS = 3;

export type AttemptDecision = { action: "launch"; attempt: number } | { action: "stop" };

/** `attemptsUsed` is how many cloud-agent launches have already been requested. */
export function decideAttempt(attemptsUsed: number): AttemptDecision {
  if (!Number.isInteger(attemptsUsed) || attemptsUsed < 0) {
    throw new Error("attemptsUsed must be a non-negative integer.");
  }
  if (attemptsUsed >= MAX_FIX_ATTEMPTS) {
    return { action: "stop" };
  }
  return { action: "launch", attempt: attemptsUsed + 1 };
}
