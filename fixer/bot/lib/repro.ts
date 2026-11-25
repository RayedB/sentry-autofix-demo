import { GITHUB_FULL_NAME } from "./github.js";

export const REPRO_LABEL = "sentry-repro";

export function isReproPull(input: { repoFullName: string; ref: string; labels: readonly string[] }): boolean {
  if (input.repoFullName !== GITHUB_FULL_NAME) {
    return false;
  }
  if (input.labels.includes(REPRO_LABEL)) {
    return true;
  }
  return input.ref.startsWith("cursor/repro-") || input.ref.startsWith("repro/");
}
