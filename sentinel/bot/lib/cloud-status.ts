const STOPPED_STATUSES = new Set(["finished", "error", "expired"]);

export function isStopped(status: string): boolean {
  return STOPPED_STATUSES.has(status);
}
