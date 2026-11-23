import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const releaseName = process.env.VERCEL_GIT_COMMIT_SHA;
const environment = process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV;
const sentryOrg = process.env.SENTRY_ORG || "eurodelices";
const sentryProject = process.env.SENTRY_PROJECT || "sentry-autofix-demo";
const authTokenPresent = Boolean(process.env.SENTRY_AUTH_TOKEN);

console.log(
  `[sentry-config] auth token present: ${authTokenPresent}, org=${sentryOrg}, project=${sentryProject}, release=${releaseName ?? ""}`,
);

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
  org: sentryOrg,
  project: sentryProject,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: false,
  debug: true,
  telemetry: false,
  widenClientFileUpload: true,
  // Keep the Turbopack post-compile hook on even if bundler detection misses.
  // `next build --experimental-build-mode generate` still skips it; postbuild uploads then.
  useRunAfterProductionCompileHook: true,
  sourcemaps: {
    disable: authTokenPresent ? false : "disable-upload",
    // Leave maps on disk so postbuild can upload the artifacts the hook skipped.
    deleteSourcemapsAfterUpload: false,
  },
  release: {
    ...(releaseName ? { name: releaseName } : {}),
    create: authTokenPresent,
    finalize: authTokenPresent,
    setCommits: authTokenPresent
      ? { auto: true, ignoreMissing: true }
      : false,
    ...(authTokenPresent && environment ? { deploy: { env: environment } } : {}),
  },
  webpack: {
    automaticVercelMonitors: false,
  },
});
