"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function QuoteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="shell">
      <h1>Something went wrong</h1>
      <p className="lede">We could not finish loading this page.</p>
      <button type="button" onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}
