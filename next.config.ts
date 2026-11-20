import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const release = process.env.VERCEL_GIT_COMMIT_SHA;

const uploadSourceMaps = Boolean(
  process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT,
);

const env: Record<string, string> = {};
if (release) {
  env.VERCEL_GIT_COMMIT_SHA = release;
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  env,
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  widenClientFileUpload: true,
  sourcemaps: {
    disable: uploadSourceMaps ? false : "disable-upload",
  },
  release: {
    name: release,
    create: uploadSourceMaps,
    finalize: uploadSourceMaps,
  },
  webpack: {
    automaticVercelMonitors: false,
  },
});
