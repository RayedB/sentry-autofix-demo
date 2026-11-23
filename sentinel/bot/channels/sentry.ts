import { defineChannel, hmacSignatureAuth, POST } from "@grok/agent-sdk/channels";
import * as z from "zod/v4";
import { readEventAlert } from "../lib/alert.js";
import { SENTRY_CLIENT_SECRET_NAME } from "../lib/sentry.js";

const DEDUPE_PREFIX = "sentry:issue:";

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

        const key = `${DEDUPE_PREFIX}${decision.issueId}`;
        const seen = await host.kv.get(key);
        if (seen !== undefined) {
          return new Response(null, { status: 200 });
        }
        await host.kv.put(key, {
          issueId: decision.issueId,
          acceptedAt: new Date().toISOString(),
        });

        const turn = send(decision.message, {
          continuationToken: `sentry-issue:${decision.issueId}`,
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
