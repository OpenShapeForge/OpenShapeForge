// SPDX-License-Identifier: BUSL-1.1
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const app = process.argv[2];
if (app !== "web" && app !== "admin") {
  throw new Error("Expected exactly one app argument: web or admin.");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const appRoot = join(repositoryRoot, "apps", app);
const standaloneRoot = join(appRoot, ".next", "standalone", "apps", app);
const serverPath = join(standaloneRoot, "server.js");
const preflightPath = join(standaloneRoot, "auth-preflight.mjs");
const preflightSource = join(appRoot, "src", "lib", "auth", "standalone-preflight.ts");
const staticSource = join(appRoot, ".next", "static");
const staticTarget = join(standaloneRoot, ".next", "static");
const marker = "// OpenShapeForge standalone auth preflight\n";
const preflightImport = 'import "./auth-preflight.mjs";\n';

const build = Bun.spawn([
  process.execPath,
  "build",
  preflightSource,
  "--target=node",
  "--format=esm",
  "--outfile",
  preflightPath,
], {
  cwd: repositoryRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (await build.exited !== 0) {
  throw new Error(`Failed to bundle the ${app} standalone auth preflight.`);
}

await mkdir(join(standaloneRoot, ".next"), { recursive: true });
await rm(staticTarget, { recursive: true, force: true });
await cp(staticSource, staticTarget, { recursive: true, force: true });

const generatedServer = await readFile(serverPath, "utf8");
if (!generatedServer.startsWith(marker)) {
  await writeFile(serverPath, `${marker}${preflightImport}${generatedServer}`);
}

const wrappedServer = await readFile(serverPath, "utf8");
if (!wrappedServer.startsWith(`${marker}${preflightImport}`)) {
  throw new Error(`Failed to secure the ${app} standalone server entrypoint.`);
}
