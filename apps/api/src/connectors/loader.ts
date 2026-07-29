// SPDX-License-Identifier: BUSL-1.1
/**
 * Resolving connector implementation packages at runtime.
 *
 * The compiler must never do this — output would depend on node_modules and the
 * determinism gates would break — so resolution happens here, once, at boot.
 *
 * Every load is gated twice before anything is trusted: the provenance gate
 * decides whether this deployment may execute the package at all, and the
 * contract handshake decides whether what loaded is actually the package the
 * contract describes. A package that fails either is recorded as unavailable
 * with a reason; it never partially loads, and it never fails startup, because
 * one bad connector must not take an API down.
 */
import {
  ConnectorContractBoundary,
  ConnectorBoundaryError,
  type BoundaryContract,
} from "./contract-boundary.js";
import { assertExecutable, ConnectorExecutionError, type ConnectorPackage } from "./executor.js";
import type { ConnectorContract } from "./catalog.js";

export type LoadedConnector = {
  contract: ConnectorContract;
  pkg: ConnectorPackage;
  boundary: ConnectorContractBoundary;
};

export type LoadFailureReason =
  | "provenance_refused"
  | "package_missing"
  | "contract_mismatch"
  | "invalid_module";

export type LoadFailure = {
  slug: string;
  reason: LoadFailureReason;
  message: string;
};

export type ConnectorRegistry = {
  loaded: Map<string, LoadedConnector>;
  failures: LoadFailure[];
};

function boundaryContractFor(contract: ConnectorContract): BoundaryContract {
  return {
    slug: contract.slug,
    implementation: { contractVersion: contract.implementation.contractVersion },
    checksum: contract.checksum,
    operations: contract.operations.map((operation) => ({
      key: operation.key,
      schemas: operation.schemas,
    })),
  };
}

/**
 * A module's default export, shaped enough to hand to the handshake. Anything
 * missing the callable `invoke` is rejected here rather than at first use: a
 * connector that only fails when a tenant calls it is a connector that looked
 * healthy in every dashboard until the moment it mattered.
 */
function asPackage(module: unknown): ConnectorPackage | undefined {
  const candidate = (module as { default?: unknown })?.default ?? module;
  if (!candidate || typeof candidate !== "object") return undefined;
  const shape = candidate as Partial<ConnectorPackage>;
  return typeof shape.invoke === "function" ? (candidate as ConnectorPackage) : undefined;
}

export type LoadOptions = {
  /** Injectable for tests; production uses dynamic import. */
  importModule?: (specifier: string) => Promise<unknown>;
};

export async function loadConnectorPackages(
  contracts: ConnectorContract[],
  options: LoadOptions = {},
): Promise<ConnectorRegistry> {
  const importModule = options.importModule ?? ((specifier) => import(specifier));
  const loaded = new Map<string, LoadedConnector>();
  const failures: LoadFailure[] = [];

  for (const contract of contracts) {
    try {
      // Before resolution, not after: refusing a package we already imported
      // would mean its module-level code had already run.
      assertExecutable(contract);
    } catch (error) {
      failures.push({
        slug: contract.slug,
        reason: "provenance_refused",
        message: (error as ConnectorExecutionError).message,
      });
      continue;
    }

    let module: unknown;
    try {
      module = await importModule(contract.implementation.package);
    } catch {
      // Absent is a normal state, not an error: a deployment installs the
      // connectors it is licensed for and no others.
      failures.push({
        slug: contract.slug,
        reason: "package_missing",
        message: `Package "${contract.implementation.package}" is not installed.`,
      });
      continue;
    }

    const pkg = asPackage(module);
    if (!pkg) {
      failures.push({
        slug: contract.slug,
        reason: "invalid_module",
        message: `Package "${contract.implementation.package}" does not export a connector.`,
      });
      continue;
    }

    const boundary = new ConnectorContractBoundary(boundaryContractFor(contract));
    try {
      boundary.assertPackageMatches({
        slug: pkg.slug,
        contractVersion: pkg.contractVersion,
        ...(pkg.contractChecksum === undefined
          ? {}
          : { contractChecksum: pkg.contractChecksum }),
        operations: pkg.operations,
      });
    } catch (error) {
      failures.push({
        slug: contract.slug,
        reason: "contract_mismatch",
        message: (error as ConnectorBoundaryError).message,
      });
      continue;
    }

    loaded.set(contract.slug, { contract, pkg, boundary });
  }

  return { loaded, failures };
}
