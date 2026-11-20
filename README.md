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
| `SENTRY_AUTH_TOKEN` | No | Auth token for source map upload during `next build`. |
| `SENTRY_ORG` | No | Sentry organization slug. Needed to upload source maps. |
| `SENTRY_PROJECT` | No | Sentry project slug. Needed to upload source maps. |
| `VERCEL_GIT_COMMIT_SHA` | No | Release name sent to Sentry. Vercel sets this on deploy. |

Source map upload runs only when `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` are all set. Otherwise the build skips the upload and still succeeds.

## Deploy on Vercel

The repo is a standard Next.js app. Vercel detects it with no extra build settings.

1. Import the GitHub repository at [vercel.com/new](https://vercel.com/new). Leave the framework preset on Next.js and the default build command (`next build`) and output.
2. In [Sentry](https://sentry.io), create a project and choose the Next.js platform.
3. In the Vercel project, open **Settings → Environment Variables** and add:
   - `NEXT_PUBLIC_SENTRY_DSN` — the client DSN from the Sentry project
   - `SENTRY_DSN` — the same DSN, or a separate server DSN
   - `SENTRY_ORG` — the organization slug
   - `SENTRY_PROJECT` — the project slug
   - `SENTRY_AUTH_TOKEN` — a Sentry auth token with `project:releases` and `org:read` scopes
4. Leave `VERCEL_GIT_COMMIT_SHA` unset. Vercel provides it, and the app uses that value as the Sentry release.
5. Deploy. Later deploys upload source maps when the three upload variables are present.

Events show up in Sentry after a production deploy that was built with the DSN set. Client events need `NEXT_PUBLIC_SENTRY_DSN` at build time, so change that variable and redeploy rather than only restarting.

## Continuous integration

GitHub Actions runs on pull requests and on pushes to `main`:

- `test` — lint, typecheck, and Vitest
- `e2e` — production build and Playwright
