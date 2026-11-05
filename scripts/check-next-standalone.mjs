// SPDX-License-Identifier: BUSL-1.1
// Exercise the same production start commands used by developers and CI.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

for (const app of ["web", "admin"]) {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn("bun", ["run", "start"], {
    cwd: new URL(`../apps/${app}/`, import.meta.url),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1",
      AUTH_URL: origin, AUTH_SECRET: "standalone-smoke-only-secret",
      AUTH_KEYCLOAK_ID: "standalone-smoke", AUTH_KEYCLOAK_SECRET: "standalone-smoke-only-secret",
      AUTH_KEYCLOAK_ISSUER: "http://127.0.0.1:1/realms/smoke", AUTH_COOKIE_SECURE: "false",
      REDIS_URL: "redis://127.0.0.1:1",
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    let response;
    for (let attempts = 0; attempts < 100; attempts++) {
      if (child.exitCode !== null) throw new Error(`${app} exited before startup:\n${output}`);
      try { response = await fetch(`${origin}/login`); break; } catch { await delay(100); }
    }
    if (!response?.ok) throw new Error(`${app} login did not start successfully:\n${output}`);
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+(?:\?[^"]*)?)"/g)]
      .map((match) => match[1].replaceAll("&amp;", "&"));
    for (const extension of [".css", ".js"]) {
      const asset = assets.find((path) => path.split("?")[0].endsWith(extension));
      if (!asset) throw new Error(`${app} login did not reference a ${extension} asset.`);
      const assetResponse = await fetch(`${origin}${asset}`);
      if (!assetResponse.ok) throw new Error(`${app} ${extension} asset returned ${assetResponse.status}.`);
    }
    if (output.includes('"next start" does not work')) throw new Error(`${app} emitted the standalone warning.`);
    console.log(`${app}: standalone login and static asset passed`);
  } finally {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
