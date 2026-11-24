export type ToolCaller = (
  name: string,
  input: { prNumber: number; attempt: number; headSha: string },
) => Promise<{ isError: boolean; errorMessage?: string; result: unknown }>;

let callTool: ToolCaller | undefined;

export function setCallTool(fn: ToolCaller): void {
  callTool = fn;
}

export function getCallTool(): ToolCaller {
  if (callTool === undefined) {
    throw new Error("launch_fix is unavailable until the server finishes starting.");
  }
  return callTool;
}
