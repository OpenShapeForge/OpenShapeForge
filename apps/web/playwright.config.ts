// SPDX-License-Identifier: BUSL-1.1
/**
 * Real-browser proof of the Keycloak authorization-code callback and the
 * Redis-backed opaque web session. The workflow starts the complete stack;
 * this config only drives it and fails instead of starting partial substitutes.
 */
import { defineConfig, devices } from "@playwright/test";
import { WEB_URL } from "./e2e/support/environment";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  outputDir: "./test-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
