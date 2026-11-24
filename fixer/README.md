# fixer

Agent SDK agent (`@grok/agent-sdk` 0.7.2). Every two minutes it looks at open pull requests on `RayedB/sentry-autofix-demo`. A repro is a same-repo head whose branch starts with `cursor/repro-` or `repro/`, or which has the label `sentry-repro`. It launches a cloud agent onto that branch, then squash-merges only when CI, the preview, and the diff all pass.

Node 22.13 or newer. Run the CLI with `npx @grok/agent-sdk` from this directory. Do not use Bun.

## Loop

`bot/schedules/scan.ts` is the only actor (`docs/reference/schedules.md`). Its `run` handler receives `callTool` and `host` and calls `tick` once per open pull request. `bot/channels/github.ts` only mounts `cursorAccount` so the schedule can call GitHub. It does not subscribe to webhook events.

For each pull request the tick:

1. Reads `fixer:run:<number>` from `ctx.host.kv`. A `merged` or `stopped` record returns before any other GitHub call.
2. Skips a fork and any pull request that is not a repro.
3. If `agentId` is set, calls `getCloudAgent` (`docs/guides/cloud-agents.md`). A `creating` or `running` agent returns.
4. Reads CI once: `checks.listForRef` and `listCommitStatusesForRef`. Success means the `test` and `e2e` check runs and the commit status whose `context` is `Vercel` are all `success`. A failure is red. Anything missing or still running is pending, and the tick returns.
5. When CI is green, `GET /api/version` on the branch alias must return that head SHA, then `POST /api/quote` must return 200 with a delivery label and a numeric delivery. Fetches use `redirect: "manual"`; a 3xx is a failure. The preview host is `https://sentry-autofix-demo-git-<branch-slug>-rayeds-projects.vercel.app`, not the Vercel dashboard URL on the commit status.
6. Protected files in `compare(main...head)` must match `compare(main...reproSha)` by path and blob SHA. Added repro tests must stay. A file that now matches `main` is allowed, so merging `origin/main` is allowed. An extra or edited protected file (`tests/`, `e2e/`, `*.test.*`, `*.spec.*`, `.github/workflows/`, `vitest.config.*`, `playwright.config.*`, `package.json`) comments and stops.
7. Squash-merge only after at least one launch, with `sha` set to the head. If the merge errors, the tick re-reads the pull request. `merged: true` is success. A moved head, or HTTP 409 or 405, returns without saving. Any other error comments and stops.
8. A red CI, a failed quote, or a finished agent that did not move the attempt's head uses one attempt, up to 3. The launch id is a stable `bc-<uuid>` (`docs/guides/cloud-agents.md`). A preview that stays non-200, 401, 404, or on the wrong SHA for 30 minutes comments the reason and stops. The tick writes the kv record once.

## Log in

```bash
cd fixer
npx @grok/agent-sdk login
npx @grok/agent-sdk whoami
```

Connect GitHub for `RayedB/sentry-autofix-demo` in Cursor (Settings or https://cursor.com/dashboard). `permissions` is `contents-write` because squash merge creates a commit (`docs/guides/github.md`).

## Secrets

`VERCEL_AUTOMATION_BYPASS_SECRET`. The preview is behind Vercel Authentication. The quote and version requests send it as `x-vercel-protection-bypass`. The agent calls `*.vercel.app` (`bot/agent.ts`).

```bash
printf %s "$VERCEL_AUTOMATION_BYPASS_SECRET" | npx @grok/agent-sdk secret set fixer VERCEL_AUTOMATION_BYPASS_SECRET
npx @grok/agent-sdk secret list fixer
```

Create the secret in the Vercel project under Deployment Protection → Protection Bypass for Automation. Do not put the value in the command arguments.

## Deploy

Commit and push first. `deploy` builds the pushed git ref. Redeploy sentinel so new repro pull requests get the `sentry-repro` label, then deploy fixer. From the repository root:

```bash
npx @grok/agent-sdk login
npx @grok/agent-sdk validate --dir sentinel
npx @grok/agent-sdk deploy --dir sentinel \
  --cursor-events-repo RayedB/sentry-autofix-demo
npx @grok/agent-sdk validate --dir fixer
npx @grok/agent-sdk deploy --dir fixer \
  --cursor-events-repo RayedB/sentry-autofix-demo
```

Pass `--cursor-events-repo` on every deploy. A deploy replaces the repositories the deployment watches.

## Checks

```bash
cd fixer
npm ci
npm test
npm run check
npx @grok/agent-sdk validate --dir .
```
