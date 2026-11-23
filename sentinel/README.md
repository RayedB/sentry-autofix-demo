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

Connect GitHub for `RayedB/sentry-autofix-demo` in Cursor (Settings or https://cursor.com/dashboard) before you rely on `create_github_issue`. `ctx.host.github.getOctokit()` uses that connection when a `githubChannel({ cursorAccount })` is mounted. This project does not mount one: mounting it makes `agent-sdk dev` refuse to listen until login, because the SDK treats the channel repos as cursor-events scope. Without that channel, Octokit uses `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`. On Cursor hosting, set one of those if issue creation returns an auth error, or add the channel after you confirm `dev` still starts.

## Set secrets

Secret names are `SENTRY_CLIENT_SECRET` (Sentry internal integration client secret, HMAC key) and `SENTRY_API_TOKEN` (Sentry API bearer token for `https://us.sentry.io/api/0/`).

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
npx @grok/agent-sdk deploy --dir sentinel
```

The command prints `alias:`. That value is `AGENT_ALIAS_URL`. The first deploy also prints an alias token once. Store it in a password manager. Sentry does not send that token.

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

## Checks

```bash
cd sentinel
npm ci
npm run check
npx @grok/agent-sdk validate --dir .
npx @grok/agent-sdk info --dir . --json
npx @grok/agent-sdk eval --dir . --list
npx @grok/agent-sdk eval --dir . --tag smoke
```

`eval` runs a model turn and needs `agent-sdk login`. `--list` does not.
