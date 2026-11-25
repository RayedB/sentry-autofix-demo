const STOPPED = new Set(["finished", "error", "expired"]);

export function isStopped(status: string): boolean {
  return STOPPED.has(status);
}
