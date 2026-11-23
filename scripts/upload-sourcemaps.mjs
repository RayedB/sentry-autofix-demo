import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const cli = require.resolve("@sentry/cli/bin/sentry-cli");
const org = process.env.SENTRY_ORG || "eurodelices";
const project = process.env.SENTRY_PROJECT || "sentry-autofix-demo";
const release = process.env.VERCEL_GIT_COMMIT_SHA || "";
const environment =
  process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || "production";

if (!process.env.SENTRY_AUTH_TOKEN) {
  console.log(
    `[sentry-config] auth token present: false, org=${org}, project=${project}, release=${release}`,
  );
  console.log("[sentry-config] skipping postbuild source map upload");
  process.exit(0);
}

console.log(
  `[sentry-config] auth token present: true, org=${org}, project=${project}, release=${release}`,
);
console.log("[sentry-config] uploading source maps from .next");

function run(args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0 && !allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result.status === 0;
}

const common = ["--org", org, "--project", project];
const releaseArgs = release ? ["--release", release] : [];

run([
  "sourcemaps",
  "inject",
  ...common,
  ...releaseArgs,
  "--ignore",
  "**/cache/**",
  ".next",
]);
run([
  "sourcemaps",
  "upload",
  ...common,
  ...releaseArgs,
  "--ignore",
  "**/cache/**",
  ".next",
]);

if (release) {
  const commitsLinked = run(
    [
      "releases",
      "set-commits",
      ...common,
      release,
      "--auto",
      "--ignore-missing",
    ],
    { allowFailure: true },
  );
  if (!commitsLinked) {
    console.log(
      "[sentry-config] commit association failed; source maps were still uploaded",
    );
  }
  run(["releases", "finalize", ...common, release]);
  run([
    "deploys",
    "new",
    ...common,
    "--release",
    release,
    "--env",
    environment,
  ]);
}

function removeSourceMaps(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (entry === "cache") {
        continue;
      }
      removeSourceMaps(path);
      continue;
    }
    if (entry.endsWith(".map")) {
      rmSync(path);
    }
  }
}

removeSourceMaps(".next");
console.log("[sentry-config] removed uploaded source maps from .next");
