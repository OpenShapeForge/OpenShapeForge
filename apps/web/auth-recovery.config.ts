// SPDX-License-Identifier: BUSL-1.1
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e/recovery", testMatch: "*.spec.ts", workers: 1, retries: 0, timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: "../../.runtime/auth-recovery/report", open: "never" }]],
  outputDir: "../../.runtime/auth-recovery/results",
  use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3950", video: "on", trace: "off", screenshot: "only-on-failure" },
  webServer: { command: "bun e2e/recovery/server.ts", url: "http://localhost:3950/login", reuseExistingServer: false,
    env: { AUTH_URL: "http://localhost:3950", AUTH_COOKIE_SECURE: "false",
      AUTH_KEYCLOAK_ISSUER: process.env.AUTH_RECOVERY_ISSUER ?? "",
      AUTH_KEYCLOAK_ID: "recovery-web", AUTH_KEYCLOAK_SECRET: "isolated-test-secret",
      AUTH_SECRET: "isolated-session-recovery-auth-secret" },
  },
});
