# sentinel

Agent SDK agent (`@grok/agent-sdk` 0.7.2). It receives a Sentry issue-alert webhook, reads the issue, opens a GitHub issue on `RayedB/sentry-autofix-demo`, and asks a Cursor cloud agent to add a failing test. It does not fix the Next.js app.

Node 22.13 or newer. Run the CLI with `npx @grok/agent-sdk` from this directory. Do not use Bun.

## Log in

GitHub writes and cloud-agent launches use the Cursor account. Model turns need the same login. This checkout cannot log in for you.

```bash
cd sentinel
npx @grok/agent-sdk login
npx @grok/agent-sdk whoami
```

Connect GitHub for `RayedB/sentry-autofix-demo` in Cursor (Settings or https://cursor.com/dashboard). `bot/channels/github.ts` mounts `githubChannel({ cursorAccount })`. With that mount, `ctx.host.github.getOctokit()` uses the Cursor GitHub connection. The channel returns null for pull requests, issues, and comments, so those events do not start a turn. `permissions` is `pr-write`, the documented tier for issue and comment writes. Local `dev` needs `agent-sdk login` before it listens, because the channel's repos are cursor-events scope.

## Set secrets

Secret names are `SENTRY_CLIENT_SECRET` (Sentry internal integration client secret, HMAC key) and `SENTRY_API_TOKEN` (Sentry API bearer token for `https://us.sentry.io/api/0/`). The token needs **Issue & Event: Read & Write** (`event:write`). A read-only token can open the GitHub issue and cannot resolve the Sentry issue after production verification.

Locally, export them in the shell that runs `dev`. Do not commit them.

```bash
export SENTRY_CLIENT_SECRET='the-integration-client-secret'
export SENTRY_API_TOKEN='the-sentry-auth-token'
```

On a deployment, set them after the first deploy. Pipe the value on stdin. Do not put the value in the command arguments.

```bash
printf %s "$SENTRY_CLIENT_SECRET" | npx @grok/agent-sdk secret set sentinel SENTRY_CLIENT_SECRET
printf %s "$SENTRY_API_TOKEN" | npx @grok/agent-sdk secret set sentinel SENTRY_API_TOKEN
npx @grok/agent-sdk secret list sentinel
```

## Deploy

Commit and push this directory first. `deploy` builds the pushed git ref. From the repository root:

```bash
npx @grok/agent-sdk login
npx @grok/agent-sdk validate --dir sentinel
npx @grok/agent-sdk deploy --dir sentinel \
  --cursor-events-repo RayedB/sentry-autofix-demo
```

Pass `--cursor-events-repo` on every deploy. A deploy replaces the repositories the deployment watches, and the GitHub channel uses that list together with the repos in `cursorAccount`. The command prints `alias:`. That value is `AGENT_ALIAS_URL`. A later deploy does not print the alias token again.

Manage the deployment at https://cursor.com/dashboard/deployed-agents.

## Sentry webhook URL

Paste this URL into the internal integration's issue-alert action. No trailing slash. No `X-Agent-Alias-Token` header. Sentry already sends `Sentry-Hook-Resource: event_alert` and `Sentry-Hook-Signature`.

```text
$AGENT_ALIAS_URL/v1/channels/sentry
```

`$AGENT_ALIAS_URL` is the `alias:` line from `npx @grok/agent-sdk deploy --dir sentinel` (the same line from `npx @grok/agent-sdk deployment get sentinel`). The SDK builds it as `https://api.cursor.com` plus the deployment's `engineAlias`.

`hmacSignatureAuth` admits this route through the hosting catch API. A bad signature gets `401` before the handler runs. `deployment get` prints a `public:` line only for `publicEndpoint()` routes. This route uses HMAC, so that line can be absent. The URL above is still the webhook URL.

Local `npx @grok/agent-sdk dev` (this directory is the project, so the slug is `sentinel`) listens at:

```text
http://127.0.0.1:3000/sentinel/v1/channels/sentry
```

## Test the webhook locally

Terminal 1:

```bash
cd sentinel
export SENTRY_CLIENT_SECRET='local-test-secret'
export SENTRY_API_TOKEN='unused-for-the-ack'
npx @grok/agent-sdk dev
```

Terminal 2, from `sentinel/`. A correct signature is accepted (`202`). A wrong signature is `401`. A second post of the same `issue_id` is `200` and does not start another turn.

```bash
node --input-type=module <<'EOF'
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const url = "http://127.0.0.1:3000/sentinel/v1/channels/sentry";
const secret = process.env.SENTRY_CLIENT_SECRET ?? "";
const body = readFileSync("fixtures/sentry/event-alert.json");
const signature = createHmac("sha256", secret).update(body).digest("hex");

async function post(signatureHeader, resource = "event_alert") {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sentry-hook-resource": resource,
      "sentry-hook-signature": signatureHeader,
    },
    body,
  });
  console.log(resource, signatureHeader === signature ? "valid" : "bad", response.status);
}

await post(signature);
await post("00".repeat(32));
await post(signature);
EOF
```

The fixture matches the Sentry issue-alert webhook shape: title `TypeError: Cannot read properties of undefined (reading 'label')`, culprit `POST /api/quote`, in-app frame `lib/pricing.ts:50`.

## Phase 3: production verification

After `fixer` squash-merges a repro pull request, the `verify` schedule (`*/2 * * * *`) checks production. It does not run inside a model turn.

1. Read `https://sentry-autofix-demo.vercel.app/api/version` until that deploy is the merge commit, or a newer `main` commit that contains it. The wait is 30 minutes from `merged_at`.
2. Replay the bug. An HTTP replay spec is sent to that origin with redirects disabled. A browser-only bug launches one read-only cloud agent (`launch_prod_verify`) that runs Playwright against production and does not edit, commit, push, or open a pull request.
3. On the next tick, list Sentry events for the issue and keep only `environment=production` events for that production SHA, or events timestamped at the replay. Preview events grouped into the same issue are ignored.
4. When that list is empty, resolve the Sentry issue, comment on the merged pull request and the GitHub issue, and close the GitHub issue with `state_reason: completed`.

Resolving the issue requires the `event:write` permission above. A 401 or 403 from Sentry names that permission and leaves the GitHub issue open.

Redeploy after this change. Pass `--cursor-events-repo` every time:

```bash
npx @grok/agent-sdk deploy --dir sentinel --cursor-events-repo RayedB/sentry-autofix-demo
```

## Checks

```bash
cd sentinel
npm ci
npm test
npm run check
npx @grok/agent-sdk validate --dir .
npx @grok/agent-sdk info --dir . --json
npx @grok/agent-sdk eval --dir . --list
npx @grok/agent-sdk eval --dir . --tag smoke
```

`eval` runs a model turn and needs `agent-sdk login`. `--list` does not.
