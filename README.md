# Northline Roasters

A one-page wholesale desk for pricing roasted coffee. Choose bag quantities, enter a ship-to postal code, and get a quote with delivery. Orders of $75 or more include free delivery.

## Run locally

Requires Node.js 22.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Sentry is optional. Copy `.env.example` to `.env.local` and fill in the values you have. With none of them set, the app still builds and runs.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate Next.js route types and run `tsc` |
| `npm test` | Vitest unit tests |
| `npx playwright test` | Playwright end-to-end tests (requires `npm run build` first) |

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Browser Sentry DSN. Inlined when the app is built. |
| `SENTRY_DSN` | No | Server and edge Sentry DSN. Falls back to `NEXT_PUBLIC_SENTRY_DSN`. |
| `SENTRY_AUTH_TOKEN` | No | Auth token for source map upload and release creation during `next build`. |
| `SENTRY_ORG` | No | Sentry organization slug. Defaults to `eurodelices`. |
| `SENTRY_PROJECT` | No | Sentry project slug. Defaults to `sentry-autofix-demo`. |
| `SENTRY_ENVIRONMENT` | No | Event environment. Overrides `VERCEL_ENV` when set. |
| `VERCEL_ENV` | No | Event environment on Vercel (`production`, `preview`, or `development`). Vercel sets this. |
| `VERCEL_GIT_COMMIT_SHA` | No | Sentry release name. Vercel sets this. The build plugin injects it into the SDK. |
| `SENTRY_DEBUG` | No | Set to `true` to log SDK activity, including envelope delivery. |

`next build` prints `[sentry-config] auth token present: ...` and Sentry plugin debug logs. Source map upload, release finalization, commit association, and deploy tracking run in `postbuild` only when `SENTRY_AUTH_TOKEN` is set. Without the token that step logs the same line with `false` and exits successfully. Uploaded source maps are then removed from `.next`. The release name is `VERCEL_GIT_COMMIT_SHA`.

## Deploy on Vercel

The repo is a standard Next.js app. Vercel detects it with no extra build settings.

1. Import the GitHub repository at [vercel.com/new](https://vercel.com/new). Leave the framework preset on Next.js and the default build command (`next build`) and output.
2. The Sentry project is `sentry-autofix-demo` in the `eurodelices` organization (US region). Those slugs are the defaults in `next.config.ts`.
3. In the Vercel project, open **Settings → Environment Variables** and add:
   - `NEXT_PUBLIC_SENTRY_DSN` — the client DSN
   - `SENTRY_DSN` — the same DSN, or a separate server DSN
   - `SENTRY_AUTH_TOKEN` — an organization auth token with `project:releases` and `org:read`
4. Leave `SENTRY_ORG`, `SENTRY_PROJECT`, `VERCEL_ENV`, and `VERCEL_GIT_COMMIT_SHA` unset unless you need to override them. Vercel provides `VERCEL_ENV` and `VERCEL_GIT_COMMIT_SHA`. The build uses the commit SHA as the Sentry release and `VERCEL_ENV` as the environment.
5. Deploy with the default build script (`npm run build`), which runs `postbuild`. With the auth token set, look for `[sentry-config] auth token present: true` and `sentry-cli` source map upload lines. The plugin's `compiler.runAfterProductionCompile` hook does not run for `next build --experimental-build-mode generate`, which is why upload also happens after the build.

Events show up in Sentry after a deploy that was built with the DSN set. Client events need `NEXT_PUBLIC_SENTRY_DSN` at build time, so change that variable and redeploy rather than only restarting. Server events read `SENTRY_DSN` at runtime.

## Continuous integration

GitHub Actions runs on pull requests and on pushes to `main`:

- `test` — lint, typecheck, and Vitest
- `e2e` — production build and Playwright
