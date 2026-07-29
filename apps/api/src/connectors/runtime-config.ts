// SPDX-License-Identifier: BUSL-1.1
/**
 * Deployment configuration for the connector subsystem.
 *
 * Read once at startup. Every value is optional and every absence fails closed:
 * no license key means no entitlement is ever granted, no keyring means
 * configuration writes are refused rather than storing credentials in the
 * clear.
 *
 * `installedPackages` is empty here on purpose. Resolving implementation
 * packages is the execution stage's job and is gated on the deployment's
 * execution trust model; until then every connector reports NOT_INSTALLED,
 * which is the honest answer for a runtime that cannot yet invoke one.
 */
import { keyringFromEnv, type SecretKeyring } from "./secrets.js";
import type { ConnectorRuntimeConfig } from "./service.js";

export type ConnectorEnv = {
  OPENSHAPEFORGE_LICENSE_TOKEN?: string | undefined;
  OPENSHAPEFORGE_LICENSE_PUBLIC_KEY?: string | undefined;
  OPENSHAPEFORGE_DEPLOYMENT_ID?: string | undefined;
  OPENSHAPEFORGE_CONNECTOR_SECRET_KEYS?: string | undefined;
};

export function readConnectorRuntimeConfig(
  env: ConnectorEnv = process.env as ConnectorEnv,
): ConnectorRuntimeConfig {
  let keyring: SecretKeyring | undefined;
  try {
    keyring = keyringFromEnv(env.OPENSHAPEFORGE_CONNECTOR_SECRET_KEYS);
  } catch {
    // A malformed keyring must not half-configure the subsystem: treat it as
    // absent so configuration writes refuse rather than encrypting under a key
    // nobody validated. The startup log records the rejection.
    keyring = undefined;
  }

  return {
    licenseToken: env.OPENSHAPEFORGE_LICENSE_TOKEN,
    licensePublicKey: env.OPENSHAPEFORGE_LICENSE_PUBLIC_KEY,
    deploymentId: env.OPENSHAPEFORGE_DEPLOYMENT_ID,
    keyring,
    installedPackages: new Set<string>(),
  };
}
