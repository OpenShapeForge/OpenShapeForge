// SPDX-License-Identifier: BUSL-1.1
/**
 * The process-wide connector runtime the surfaces share.
 *
 * Built once, lazily, on first use: the package registry (what loaded, and why
 * anything did not) and the governor that holds rate-limit windows, circuit
 * state and concurrency slots. Sharing one governor is the point — per-surface
 * instances would each carry their own idea of whether an upstream is healthy,
 * and a tenant could spend its rate budget three times over.
 */
import { listConnectorContracts, type ConnectorContract } from "./catalog.js";
import { loadConnectorPackages, type ConnectorRegistry } from "./loader.js";
import { ConnectorGovernor } from "./reliability.js";
import { readConnectorRuntimeConfig } from "./runtime-config.js";
import type { SecretKeyring } from "./secrets.js";

let registryPromise: Promise<ConnectorRegistry> | undefined;
const governor = new ConnectorGovernor();

export function connectorRegistry(
  contracts: ConnectorContract[] = listConnectorContracts(),
): Promise<ConnectorRegistry> {
  registryPromise ??= loadConnectorPackages(contracts);
  return registryPromise;
}

export function connectorGovernor(): ConnectorGovernor {
  return governor;
}

export function connectorKeyring(): SecretKeyring | undefined {
  return readConnectorRuntimeConfig().keyring;
}

/** Test seam: forget the loaded registry so a suite can install its own. */
export function __resetConnectorRegistryForTests(next?: Promise<ConnectorRegistry>): void {
  registryPromise = next;
}
