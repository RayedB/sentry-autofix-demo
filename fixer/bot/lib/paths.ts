/** True when a compare path is a test file the fixer must not ship. */
export function isTestPath(file: string): boolean {
  const path = file.replace(/\\/g, "/");
  if (path.startsWith("tests/") || path.includes("/tests/")) {
    return true;
  }
  if (path.startsWith("e2e/") || path.includes("/e2e/")) {
    return true;
  }
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.includes(".test.") || base.includes(".spec.");
}
