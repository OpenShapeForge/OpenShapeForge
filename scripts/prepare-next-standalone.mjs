// SPDX-License-Identifier: BUSL-1.1
// Next's standalone server deliberately omits public files and static assets.
// Stage them beside the generated server whenever an app starts, so a fresh
// build and a rebuilt app cannot serve missing or stale client assets.
import { cpSync, existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const appDirectory = process.cwd();
const app = basename(appDirectory);
if (!["web", "admin"].includes(app)) {
  throw new Error("Run this script from apps/web or apps/admin.");
}

const standalone = join(appDirectory, ".next", "standalone", "apps", app);
if (!existsSync(join(standalone, "server.js"))) {
  throw new Error(`Standalone ${app} server is missing; build the app first.`);
}

for (const [source, destination, required] of [
  [join(appDirectory, ".next", "static"), join(standalone, ".next", "static"), true],
  [join(appDirectory, "public"), join(standalone, "public"), false],
]) {
  if (required && !existsSync(source)) {
    throw new Error(`Required static assets are missing: ${source}`);
  }
  rmSync(destination, { recursive: true, force: true });
  if (existsSync(source)) cpSync(source, destination, { recursive: true });
}
