import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const releaseName = process.env.VERCEL_GIT_COMMIT_SHA;
const environment = process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV;
const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN);

const env: Record<string, string> = {};
if (releaseName) {
  env.VERCEL_GIT_COMMIT_SHA = releaseName;
}
if (process.env.SENTRY_ENVIRONMENT) {
  env.SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT;
}
if (process.env.VERCEL_ENV) {
  env.VERCEL_ENV = process.env.VERCEL_ENV;
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  env,
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG || "eurodelices",
  project: process.env.SENTRY_PROJECT || "sentry-autofix-demo",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  widenClientFileUpload: true,
  sourcemaps: {
    disable: uploadSourceMaps ? false : "disable-upload",
    deleteSourcemapsAfterUpload: true,
  },
  release: {
    ...(releaseName ? { name: releaseName } : {}),
    create: uploadSourceMaps,
    finalize: uploadSourceMaps,
    setCommits: uploadSourceMaps
      ? { auto: true, ignoreMissing: true }
      : false,
    ...(uploadSourceMaps && environment
      ? { deploy: { env: environment } }
      : {}),
  },
  webpack: {
    automaticVercelMonitors: false,
  },
});
