import * as Sentry from "@sentry/nextjs";
import { sentryRuntimeOptions } from "./sentry.shared";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  ...sentryRuntimeOptions(),
});
