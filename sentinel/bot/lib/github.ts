export const GITHUB_OWNER = "RayedB";
export const GITHUB_REPO = "sentry-autofix-demo";
export const GITHUB_REPO_URL = "https://github.com/RayedB/sentry-autofix-demo";

export function isEvalSession(purpose: string | undefined): boolean {
  return purpose === "eval";
}
