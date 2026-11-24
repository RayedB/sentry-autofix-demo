/** Body line and label sentinel asks the repro cloud agent to add. */
export const REPRO_MARKER = "sentry-repro";

const BRANCH_PREFIXES = ["cursor/repro-", "repro/"] as const;

export function isReproRef(ref: string): boolean {
  return BRANCH_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

export function isReproPull(input: {
  ref: string;
  body: string;
  labels: readonly string[];
}): boolean {
  if (isReproRef(input.ref)) {
    return true;
  }
  if (input.labels.includes(REPRO_MARKER)) {
    return true;
  }
  return input.body.includes(REPRO_MARKER);
}
