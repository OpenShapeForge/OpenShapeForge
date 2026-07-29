// SPDX-License-Identifier: BUSL-1.1
/**
 * The connector catalog and configuration service.
 *
 * Joins the three things that decide what a tenant may do with a connector:
 * the compiled contract (static), the deployment license and tenant grants
 * (entitlement), and the tenant's installations (state). Every surface —
 * GraphQL, REST, and later MCP — goes through here, so they cannot answer
 * differently.
 *
 * Reads never yield a secret value. `describeConnector` returns the field NAMES
 * that have a stored value, so a caller learns "apiKey is set" and nothing more.
 */
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import { requiredSecretFields, type ConnectorContract } from "./catalog.js";
import {
  ConnectorConfigurationError,
  ConnectorConfigurationValidator,
} from "./configuration.js";
import {
  activeTenantGrants,
  resolveAvailability,
  verifyLicenseToken,
  type ConnectorAvailability,
} from "./entitlements.js";
import { redactConfiguration, type SecretKeyring } from "./secrets.js";
import {
  describeContractDrift,
  isUsable,
  type ContractDriftReport,
} from "./status.js";
import {
  listEntitlementGrants,
  listInstallations,
  setInstallationEnabled,
  upsertInstallation,
  type ConnectorInstallation,
} from "./store.js";

export class ConnectorServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectorServiceError";
    this.code = code;
  }
}

export type ConnectorRuntimeConfig = {
  /** PEM public key that verifies the deployment license. */
  licensePublicKey?: string | undefined;
  licenseToken?: string | undefined;
  deploymentId?: string | undefined;
  keyring?: SecretKeyring | undefined;
  /** Slugs whose implementation package resolved at boot. */
  installedPackages: ReadonlySet<string>;
};

export type ConnectorInstallationView = {
  instanceKey: string;
  displayName: string | null;
  enabled: boolean;
  /** Secrets appear as a sentinel; non-secret values are returned as stored. */
  configuration: Record<string, unknown>;
  contract: ContractDriftReport;
};

export type ConnectorView = {
  slug: string;
  name: string;
  title: string;
  category?: string;
  license: ConnectorContract["implementation"]["license"];
  provenance: ConnectorContract["implementation"]["provenance"];
  requiredEntitlement?: string;
  status: ConnectorAvailability;
  /** The configuration field contract; a generic form renders from this. */
  configFields: ConnectorContract["configuration"]["fields"];
  instances: "single" | "multiple";
  installations: ConnectorInstallationView[];
};

function licensedEntitlements(config: ConnectorRuntimeConfig, now: number): Set<string> {
  const status = verifyLicenseToken(
    config.licenseToken,
    config.licensePublicKey,
    now,
    config.deploymentId,
  );
  // Fail closed: any rejection yields the empty set, so only connectors that
  // require no entitlement remain available.
  return status.valid ? new Set(status.license.entitlements) : new Set();
}

function viewInstallation(
  contract: ConnectorContract,
  installation: ConnectorInstallation,
): ConnectorInstallationView {
  return {
    instanceKey: installation.instanceKey,
    displayName: installation.displayName,
    enabled: installation.enabled,
    configuration: redactConfiguration(
      installation.config,
      contract.configuration.secretFields,
      installation.storedSecretFields,
    ),
    contract: describeContractDrift(
      contract,
      installation,
      installation.storedSecretFields,
    ),
  };
}

export type CatalogContext = {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  config: ConnectorRuntimeConfig;
  now: number;
  /**
   * The compiled contracts this request is answered from. Passed in rather than
   * imported here so the service has no module-level dependency on the
   * generated artifact: callers supply the real catalog, tests supply a
   * fixture, and neither has to reach around the other.
   */
  contracts: ConnectorContract[];
};

/** The whole catalog, as this tenant sees it. */
export async function listConnectors(context: CatalogContext): Promise<ConnectorView[]> {
  const [installations, grants] = await Promise.all([
    listInstallations(context.db, context.session),
    listEntitlementGrants(context.db, context.session),
  ]);
  const licensed = licensedEntitlements(context.config, context.now);
  const tenantGrants = activeTenantGrants(grants, context.now);

  const bySlug = new Map<string, ConnectorInstallation[]>();
  for (const installation of installations) {
    const list = bySlug.get(installation.connectorSlug) ?? [];
    list.push(installation);
    bySlug.set(installation.connectorSlug, list);
  }

  return context.contracts.map((contract) => {
    const own = bySlug.get(contract.slug) ?? [];
    const usable = own.filter((installation) =>
      isUsable(describeContractDrift(contract, installation, installation.storedSecretFields).state),
    );
    const status = resolveAvailability({
      ...(contract.availability.entitlement !== undefined
        ? { requiredEntitlement: contract.availability.entitlement }
        : {}),
      licensed,
      tenantGrants,
      packageInstalled: context.config.installedPackages.has(contract.slug),
      configured: usable.length > 0,
      enabled: usable.some((installation) => installation.enabled),
    });

    return {
      slug: contract.slug,
      name: contract.connector,
      title: contract.title,
      ...(contract.category !== undefined ? { category: contract.category } : {}),
      license: contract.implementation.license,
      provenance: contract.implementation.provenance,
      ...(contract.availability.entitlement !== undefined
        ? { requiredEntitlement: contract.availability.entitlement }
        : {}),
      status,
      configFields: contract.configuration.fields,
      instances: contract.configuration.instances,
      installations: own.map((installation) => viewInstallation(contract, installation)),
    };
  });
}

export async function describeConnector(
  context: CatalogContext,
  slug: string,
): Promise<ConnectorView | undefined> {
  return (await listConnectors(context)).find((view) => view.slug === slug);
}

function requireContract(context: CatalogContext, slug: string): ConnectorContract {
  const contract = context.contracts.find((candidate) => candidate.slug === slug);
  if (!contract) {
    throw new ConnectorServiceError("CONNECTOR_NOT_FOUND", `Unknown connector "${slug}".`);
  }
  return contract;
}

export type ConfigureInput = {
  slug: string;
  instanceKey?: string;
  displayName?: string | null;
  configuration: unknown;
};

/**
 * Install or reconfigure a connector.
 *
 * An unlicensed connector cannot be configured at all — refusing only at
 * invocation time would let a tenant stage credentials for something it may not
 * run, and would make the catalog's NOT_LICENSED advisory rather than binding.
 */
export async function configureConnector(
  context: CatalogContext,
  input: ConfigureInput,
): Promise<ConnectorInstallationView> {
  const contract = requireContract(context, input.slug);
  const keyring = context.config.keyring;
  if (!keyring) {
    throw new ConnectorServiceError(
      "CONNECTOR_SECRETS_NOT_CONFIGURED",
      "Connector secret encryption is not configured on this deployment.",
    );
  }

  const grants = await listEntitlementGrants(context.db, context.session);
  const licensed = licensedEntitlements(context.config, context.now);
  const tenantGrants = activeTenantGrants(grants, context.now);
  const required = contract.availability.entitlement;
  if (required !== undefined && (!licensed.has(required) || !tenantGrants.has(required))) {
    throw new ConnectorServiceError(
      "CONNECTOR_NOT_LICENSED",
      `Connector "${input.slug}" is not licensed for this tenant.`,
    );
  }

  const instanceKey = input.instanceKey ?? "default";
  const existing = (await listInstallations(context.db, context.session)).filter(
    (installation) => installation.connectorSlug === contract.slug,
  );
  if (
    contract.configuration.instances === "single" &&
    existing.length > 0 &&
    !existing.some((installation) => installation.instanceKey === instanceKey)
  ) {
    throw new ConnectorServiceError(
      "CONNECTOR_SINGLE_INSTANCE",
      `Connector "${input.slug}" allows a single installation per tenant.`,
    );
  }

  const validator = new ConnectorConfigurationValidator(contract);
  const split = validator.parse(input.configuration);

  const alreadyStored =
    existing.find((installation) => installation.instanceKey === instanceKey)
      ?.storedSecretFields ?? new Set<string>();
  const missing = validator.missingSecrets(
    split,
    alreadyStored,
    requiredSecretFields(contract),
  );
  if (missing.length > 0) {
    throw new ConnectorConfigurationError(
      `Connector "${input.slug}" is missing required secrets: ${missing.join(", ")}.`,
    );
  }

  const installation = await upsertInstallation(context.db, context.session, keyring, {
    connectorSlug: contract.slug,
    instanceKey,
    displayName: input.displayName ?? null,
    config: split.config,
    secrets: split.secrets,
    contractVersion: contract.implementation.contractVersion,
    contractChecksum: contract.checksum,
  });

  return viewInstallation(contract, installation);
}

export async function setConnectorEnabled(
  context: CatalogContext,
  slug: string,
  instanceKey: string,
  enabled: boolean,
): Promise<boolean> {
  const contract = requireContract(context, slug);
  if (enabled) {
    // Enabling is the moment a connector becomes reachable, so the drift state
    // is checked here rather than only being reported.
    const view = await describeConnector(context, slug);
    const installation = view?.installations.find(
      (candidate) => candidate.instanceKey === instanceKey,
    );
    if (!installation) {
      throw new ConnectorServiceError(
        "CONNECTOR_NOT_CONFIGURED",
        `Connector "${slug}" has no installation "${instanceKey}".`,
      );
    }
    if (!isUsable(installation.contract.state)) {
      throw new ConnectorServiceError(
        "CONNECTOR_NEEDS_REPAIR",
        `Connector "${slug}" cannot be enabled: ${installation.contract.reason ?? "its contract changed."}`,
      );
    }
  }
  void contract;
  return setInstallationEnabled(
    context.db,
    context.session,
    slug,
    instanceKey,
    enabled,
  );
}
