// SPDX-License-Identifier: BUSL-1.1
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({ testDir: './keycloak-evidence', timeout: 90_000, expect: { timeout: 30_000 }, workers: 1, retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../../.runtime/keycloak-invitation-report', open: 'never' }]],
  outputDir: '../../.runtime/keycloak-invitation-results',
  use: { ...devices['Desktop Chrome'], channel: 'chrome', video: 'on', trace: 'off', screenshot: 'only-on-failure' },
});
