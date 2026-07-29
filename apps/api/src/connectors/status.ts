// SPDX-License-Identifier: BUSL-1.1
/**
 * Per-installation health against the CURRENTLY COMPILED contract.
 *
 * A connector contract outlives no installation by accident: a deployment
 * compiles a new contract and every existing installation is suddenly measured
 * against it. Review point 7 is that this must be visible rather than
 * discovered at call time — a build can succeed while every tenant's stored
 * configuration has quietly become invalid.
 *
 * So an installation records the contract version and checksum it was
 * configured against, and this module reports what changed and whether the
 * operator has to act.
 */
import type { ConnectorContract } from "./catalog.js";

export type InstallationContractState =
  | "CURRENT"
  | "CONTRACT_CHANGED"
  | "NEEDS_REPAIR"
  | "INCOMPATIBLE";

export type InstallationRecord = {
  connectorSlug: string;
  instanceKey: string;
  config: Record<string, unknown>;
  enabled: boolean;
  contractVersion: number;
  contractChecksum: string;
};

export type ContractDriftReport = {
  state: InstallationContractState;
  /** Config fields the contract now requires that the installation lacks. */
  missingRequiredFields: string[];
  /** Stored config keys the contract no longer declares. */
  removedFields: string[];
  /** Human-readable reason, safe to surface. Never contains values. */
  reason?: string;
  /** Whether the connector must be re-verified before it is trusted again. */
  requiresReverification: boolean;
};

function declaredFieldKeys(contract: ConnectorContract): Set<string> {
  return new Set(contract.configuration.fields.map((field) => field.key));
}

function requiredNonSecretFields(contract: ConnectorContract): string[] {
  return contract.configuration.fields
    .filter((field) => field.required === true && field.secret !== true)
    .map((field) => field.key);
}

/**
 * Classify an installation against the compiled contract.
 *
 * The ordering is deliberate. A contract-VERSION change is incompatible: the
 * package contract itself moved, so nothing about the stored configuration can
 * be assumed. Only within the same version does a checksum change get
 * interpreted field by field.
 */
export function describeContractDrift(
  contract: ConnectorContract,
  installation: InstallationRecord,
  storedSecretFields: ReadonlySet<string>,
): ContractDriftReport {
  if (installation.contractVersion !== contract.implementation.contractVersion) {
    return {
      state: "INCOMPATIBLE",
      missingRequiredFields: [],
      removedFields: [],
      reason:
        `Installed against contract version ${installation.contractVersion}; this build ` +
        `compiles version ${contract.implementation.contractVersion}.`,
      requiresReverification: true,
    };
  }

  if (installation.contractChecksum === contract.checksum) {
    return {
      state: "CURRENT",
      missingRequiredFields: [],
      removedFields: [],
      requiresReverification: false,
    };
  }

  const declared = declaredFieldKeys(contract);
  const removedFields = Object.keys(installation.config)
    .filter((key) => !declared.has(key))
    .sort();

  const missingRequiredFields = [
    ...requiredNonSecretFields(contract).filter(
      (key) => installation.config[key] === undefined,
    ),
    ...contract.configuration.fields
      .filter((field) => field.required === true && field.secret === true)
      .map((field) => field.key)
      .filter((key) => !storedSecretFields.has(key)),
  ].sort();

  // A missing required field means the stored configuration cannot satisfy the
  // contract — an operator has to supply something. Anything else is a change
  // the platform can carry forward on its own.
  if (missingRequiredFields.length > 0) {
    return {
      state: "NEEDS_REPAIR",
      missingRequiredFields,
      removedFields,
      reason: `The contract now requires ${missingRequiredFields.join(", ")}.`,
      requiresReverification: true,
    };
  }

  return {
    state: "CONTRACT_CHANGED",
    missingRequiredFields: [],
    removedFields,
    reason:
      removedFields.length > 0
        ? `The contract no longer declares ${removedFields.join(", ")}; those values are ignored.`
        : "The contract changed; stored configuration still satisfies it.",
    // A changed contract may mean changed upstream behaviour even when the
    // configuration still fits, so a re-verify is warranted before trusting it.
    requiresReverification: true,
  };
}

/**
 * An installation is only usable when its contract state does not demand an
 * operator. CONTRACT_CHANGED is deliberately usable: blocking every tenant on
 * a help-text edit would make contract changes unshippable.
 */
export function isUsable(state: InstallationContractState): boolean {
  return state === "CURRENT" || state === "CONTRACT_CHANGED";
}
