export function sentryRuntimeOptions(): {
  release?: string;
  environment?: string;
  tracesSampleRate: number;
  debug?: boolean;
} {
  const release = process.env.VERCEL_GIT_COMMIT_SHA;
  const environment = process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV;

  return {
    ...(release ? { release } : {}),
    ...(environment ? { environment } : {}),
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1 : 0.1,
    ...(process.env.SENTRY_DEBUG === "true" ? { debug: true } : {}),
  };
}
