/** Paths a fix must not change: tests, workflows, and the test runner config. */
export function isProtectedPath(file: string): boolean {
  const path = file.replace(/\\/g, "/");
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (path === "package.json" || path.endsWith("/package.json")) {
    return true;
  }
  if (path.startsWith(".github/workflows/") || path.includes("/.github/workflows/")) {
    return true;
  }
  if (path.startsWith("tests/") || path.includes("/tests/")) {
    return true;
  }
  if (path.startsWith("e2e/") || path.includes("/e2e/")) {
    return true;
  }
  if (base.startsWith("vitest.config.") || base.startsWith("playwright.config.")) {
    return true;
  }
  return base.includes(".test.") || base.includes(".spec.");
}
