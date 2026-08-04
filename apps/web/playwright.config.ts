// SPDX-License-Identifier: BUSL-1.1
/**
 * The browser suite for `apps/web`.
 *
 * This runs a real Chromium against a running stack — Postgres, Redis,
 * Keycloak, `apps/api` and `apps/web` — because the two defects it exists to
 * catch are invisible to every other gate here. One is an effect that never
 * settles, which needs a framework doing real revalidation to reproduce; the
 * other is a `dataTransfer` read that only a browser refuses. A simulated DOM
 * answers that read with the payload, so a component test over the broken
 * handler goes green. See issue #275.
 *
 * It does NOT make `apps/web` a place to put logic. This suite drives the
 * assembled screen through the browser; it cannot reach a function, and every
 * source comment saying decisions live in `examples/plugins/workflow/web/`
 * still holds for the reason it states.
 *
 * ## Processes are not started from here
 *
 * A `webServer` entry could launch `next start`, but not the API, the
 * migrations or Keycloak, and the environment those need belongs to whoever
 * stands the stack up. So the suite assumes the stack is already running and
 * says so when it is not. `.github/workflows/web-e2e.yml` is the worked
 * example; locally, `docker compose -f docker-compose.local.yml up -d` plus
 * `bun run dev:api` and `bun run dev:web` is the same thing by hand.
 *
 * ## The origin is not free to choose
 *
 * Sign-in is the real authorization-code flow, so the browser comes back to a
 * redirect URI the realm's gateway client accepts. The authored dev realm lists
 * `http://localhost:3000/*` and `http://localhost:3001/*`
 * (`packages/compiler/config/authoring/authorization.yaml`), which is why the
 * default below is port 3000. Pointing `E2E_WEB_URL` somewhere else means
 * adding that origin to the client first, or Keycloak refuses the callback.
 */
import { defineConfig, devices } from "@playwright/test";
import { AUTH_STATE_PATH, WEB_URL } from "./e2e/support/environment";

export default defineConfig({
  testDir: "./e2e",
  // A test that stops making progress must fail rather than hang a CI job.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Serial on purpose. The specs share one signed-in identity and one workflow
  // schema, and the suite is three tests: parallelism would buy seconds and
  // cost the ability to read a failure without asking what else was running.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // No retries. This suite is a detector, and a detector that passes on the
  // second attempt has reported nothing. A flake here is a bug to fix, in the
  // test or in the app.
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      // Signs in once through the Keycloak login page and writes the cookies
      // every other project starts from. Its own file so a sign-in failure
      // reads as a sign-in failure rather than as three broken specs.
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
    },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: AUTH_STATE_PATH },
      testIgnore: /auth\.setup\.ts$/,
    },
  ],
});
