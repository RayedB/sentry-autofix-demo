# fixer

Agent SDK agent (`@grok/agent-sdk` 0.7.2). It watches `RayedB/sentry-autofix-demo` for a sentinel repro pull request whose CI is failing, pushes a production-code fix onto that same branch, checks the Vercel preview, and squash-merges when CI and the preview both pass.

Node 22.13 or newer. Run the CLI with `npx @grok/agent-sdk` from this directory. Do not use Bun.

## What it treats as a repro

A pull request matches when any of these are true:

- the head branch starts with `cursor/repro-` or `repro/`
- the body contains the line `sentry-repro`
- the pull request has the label `sentry-repro`

`cursor/repro-6-1efe` matches the branch prefix, so the existing repro pull request matches without a new push. Sentinel's cloud-agent prompt now also asks for the `sentry-repro` line and label.

## How it wakes

GitHub does not replay an old `check_suite`. A pull request that is already failing is picked up by the minute schedule in `bot/schedules/scan.ts`. New failures wake immediately.

| Wake | Hook | What it does |
| --- | --- | --- |
| `check_suite` completed | `onCheckSuite` | Reads the current head, checks, and deployments |
| `pull_request` opened, synchronize, reopened, ready for review, labeled, closed | `onPullRequest` | Same sync for a repro branch, body line, or label |
| `deployment` and `deployment_status` | `onEvent` | Those events have no typed hook. `webhookEvents` subscribes to them |
| commit `status` whose context or target URL is Vercel | `onStatus` | Same sync, so a preview URL on the status is enough when the deployment event is only a stub |
| every minute | `bot/schedules/scan.ts` | Lists open repro pull requests and runs the same sync |

The sync is host code. It stores one record per pull request in `ctx.host.kv` under `fixer:run:<number>`. A head that already has a cloud agent id is not launched again. The launch id is a stable `bc-<uuid>` derived from the pull request, head SHA, and attempt, which is the documented retry key for `launchCloudAgent`.

`deployment_status` carries `environment_url`. The commit `status` carries `target_url`. A successful deploy with neither URL falls back to `https://sentry-autofix-demo-git-<branch-slug>-rayeds-projects.vercel.app`.

## What a pass requires

1. At most three cloud-agent launches. Each launch is told to push onto the current branch and to leave test files unchanged. `launchCloudAgent` is called with that pull request's `prUrl`, `autoCreatePR: false`, and `workOnCurrentBranch: true`.
2. The preview for the new head answers `POST /api/quote` with `{"lines":[{"sku":"ethiopia","quantity":1}],"postalCode":"10001"}`. The response must be HTTP 200 and include a non-empty `deliveryLabel` and a numeric `delivery`.
3. Every GitHub check run on that head completed with success, skipped, or neutral, and commit statuses are success.
4. Squash merge that head. A 409 means the head moved, so the next sync verifies the new head. Any other merge error is commented and the run stops.
5. After three failed attempts, or three failed launches, it comments the failure summary and does not merge.

CI failure retries without waiting forever for a preview. A failed preview retries even if CI is still pending. A successful CI waits until the preview can be checked.

## Log in

GitHub writes, squash merges, and cloud-agent launches use the Cursor account. This checkout cannot log in for you.

```bash
cd fixer
npx @grok/agent-sdk login
npx @grok/agent-sdk whoami
```

Connect GitHub for `RayedB/sentry-autofix-demo` in Cursor (Settings or https://cursor.com/dashboard). `bot/channels/github.ts` mounts `githubChannel({ cursorAccount })`.

`permissions` is `contents-write`. The `pr-write` tier is documented as comments and pull-request writes with no `contents:write`. Squash merge creates a commit, so it needs the contents-write tier (`cursorAccount.permissions` in `@grok/agent-sdk/channels/github`).

## Secrets

GitHub and the cloud agent use the Cursor account from `agent-sdk login`.

The preview for this project is behind Vercel Authentication. A POST without a bypass returns HTTP 401 `Protected deployment`. Set `VERCEL_AUTOMATION_BYPASS_SECRET` to the project's Protection Bypass for Automation secret. The quote request sends it as `x-vercel-protection-bypass`. When CI is green and the preview is still blocked, fixer comments and stops instead of merging or launching another code change.

The agent calls `*.vercel.app`. That host is `hosting.egressDomains` in `bot/agent.ts`.

```bash
printf %s "$VERCEL_AUTOMATION_BYPASS_SECRET" | npx @grok/agent-sdk secret set fixer VERCEL_AUTOMATION_BYPASS_SECRET
npx @grok/agent-sdk secret list fixer
```

Create the secret in the Vercel project under Deployment Protection → Protection Bypass for Automation. Do not put the value in the command arguments.

## Deploy

Commit and push this directory first. `deploy` builds the pushed git ref. From the repository root:

```bash
npx @grok/agent-sdk login
npx @grok/agent-sdk validate --dir fixer
npx @grok/agent-sdk deploy --dir fixer \
  --cursor-events-repo RayedB/sentry-autofix-demo
```

Pass `--cursor-events-repo` on every deploy. A deploy replaces the repositories the deployment watches, and the GitHub channel uses that list together with the repos in `cursorAccount`.

Manage the deployment at https://cursor.com/dashboard/deployed-agents.

## Checks

```bash
cd fixer
npm ci
npm test
npm run check
npx @grok/agent-sdk validate --dir .
npx @grok/agent-sdk info --dir . --json
npx @grok/agent-sdk eval --dir . --list
npx @grok/agent-sdk eval --dir . --tag smoke
```

`eval` runs a model turn and needs `agent-sdk login`. `--list` does not. `npm test` covers preview URL resolution, the quote check, and attempt counting without a login.
