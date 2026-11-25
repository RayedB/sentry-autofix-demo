import { defineChannel, hmacSignatureAuth, POST } from "@grok/agent-sdk/channels";
import * as z from "zod/v4";
import { readEventAlert } from "../lib/alert.js";
import { isRecord } from "../lib/json.js";
import { sentryIssueKey } from "../lib/links.js";
import { extractReplaySpec, replayToJson } from "../lib/replay.js";
import { SENTRY_CLIENT_SECRET_NAME } from "../lib/sentry.js";

export default defineChannel({
  auth: [
    hmacSignatureAuth({
      header: "Sentry-Hook-Signature",
      secret: SENTRY_CLIENT_SECRET_NAME,
    }),
  ],
  routes: [
    POST("/", {
      description: "Sentry internal-integration issue alert webhook",
      bodySchema: z.unknown(),
      handler: async (request, { send, waitUntil, host, body }) => {
        const decision = readEventAlert(body, request.headers.get("sentry-hook-resource"));
        if (decision.kind === "ignore") {
          return new Response(null, { status: 200 });
        }

        const key = sentryIssueKey(decision.issueId);
        const seen = await host.kv.get(key);
        if (seen !== undefined) {
          return new Response(null, { status: 200 });
        }
        const replay = extractReplaySpec(eventOf(body));
        await host.kv.put(key, {
          issueId: decision.issueId,
          acceptedAt: new Date().toISOString(),
          ...(replay !== null ? { replay: replayToJson(replay) } : {}),
        });

        const turn = send(decision.message, {
          continuationToken: key,
          title: decision.title,
          workspaceFiles: {
            "sentry/event-alert.json": decision.snapshot,
          },
        }).then(
          () => undefined,
          (error: unknown) => {
            const message = error instanceof Error ? error.message : "alert turn failed";
            console.error(`sentry alert ${decision.issueId}: ${message}`);
          },
        );
        waitUntil(turn);
        return new Response(null, { status: 202 });
      },
    }),
  ],
});

function eventOf(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.data)) {
    return null;
  }
  return body.data.event;
}
