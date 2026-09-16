// SPDX-License-Identifier: BUSL-1.1
/**
 * What the `osf-control` Operations need from the process, assembled once at
 * boot (roles/api.ts) and handed to every handler through the module runtime
 * context (`ModuleRuntimeContext.control`).
 *
 * The same composition the platform administrator MCP made for itself
 * before the control plane became canonical Operations: the control-plane
 * configuration, the Keycloak clients built from it, and the one loaded
 * module that administers a catalog. Kept as one value so REST, MCP and the
 * generic Operation routes cannot disagree about whether the control plane
 * is configured — an unconfigured deployment answers
 * CONTROL_PLANE_NOT_CONFIGURED by name on all of them, naming what is missing,
 * rather than 404 on one and 500 on another.
 */
import type { McpClientInfo } from "../mcp/session-client.js";
import type { RuntimeModule } from "../modules/contract.js";
import type { OperationContract } from "../operations/runtime.js";
import { readControlPlaneConfig, type ControlPlaneConfig, type ControlPlaneConfigResult } from "./config.js";
import type { FirstAdministratorClients } from "./first-tenant-administrator.js";
import { createKeycloakOrganizationMembersClient } from "./keycloak-organization-members.js";
import type { KeycloakTenantMemberAdminClient } from "./keycloak-organization-members.js";
import { createKeycloakOrganizationAdminClient, KeycloakAdminError } from "./keycloak-organization-admin.js";
import { createServiceAccountTokenProvider } from "./keycloak-service-account.js";
import { createKeycloakSpiClient, KeycloakSpiError } from "./keycloak-spi-client.js";
import { createOrganizationScopeAdminClient } from "./organization-scopes.js";
import { createMemberRoleAdminClient, type MemberRoleAdminClient } from "./member-role-admin.js";
import type { PlatformCatalogProvider } from "./platform-catalog.js";
import type { ControlDeps } from "./tenant-registry.js";

/** The Keycloak surfaces the control Operations reach, built from one configuration. */
export type PlatformKeycloakClients = {
  firstAdministrator: FirstAdministratorClients;
  identityMembers?: KeycloakTenantMemberAdminClient;
  memberRoles?: MemberRoleAdminClient;
  control: Omit<ControlDeps, "db" | "operator">;
};

/**
 * What a transport knows about the session it serves, for `whoami`. The MCP
 * server sets it per session (the client that opened it, the tools it
 * listed); a transport without that knowledge leaves it absent and whoami
 * counts from the contracts instead.
 */
export type ControlPresentation = {
  /** The MCP client as it introduced itself at `initialize`; null on a single shot. */
  client: McpClientInfo | null;
  /** How many tools and resources this session can use. */
  access: () => { tools: number; resources: number };
};

export type ControlRuntime = {
  /**
   * Read once at boot. `ok: false` names every missing variable; every
   * control Operation then answers 503 CONTROL_PLANE_NOT_CONFIGURED with it.
   */
  config: ControlPlaneConfigResult;
  /** Present exactly when the configuration is complete. */
  clients?: PlatformKeycloakClients | undefined;
  /** The one loaded module that administers a catalog; absent when none does. */
  provider: PlatformCatalogProvider | undefined;
  /**
   * The control-realm Operations in force — the `osf-control` entries of the
   * catalog this process bound. Read by whoami to count what a session may
   * use when no transport said so; never consulted for authorization.
   */
  operations: readonly OperationContract[];
  /** Where an unclassified handler fault goes; the response itself is redacted. */
  log?: ((error: unknown) => void) | undefined;
  /** Per-session transport knowledge for whoami; see {@link ControlPresentation}. */
  presentation?: ControlPresentation | undefined;
};

/**
 * Keycloak clients used by the control Operations. Kept as one composition
 * boundary so tests can prove that the SPI and Admin API preserve their own
 * refusal classes even though both obtain the same service-account credential.
 */
export function createPlatformKeycloakClients(
  config: ControlPlaneConfig,
  options: { fetch?: typeof globalThis.fetch } = {},
): PlatformKeycloakClients {
  const spiTokens = createServiceAccountTokenProvider(config.keycloak, {
    ...options,
    unauthorized: (message, status) =>
      new KeycloakSpiError("KEYCLOAK_SPI_UNAUTHORIZED", message, status),
    unavailable: (message, status) =>
      new KeycloakSpiError("KEYCLOAK_SPI_UNAVAILABLE", message, status),
  });
  const adminTokens = createServiceAccountTokenProvider(config.keycloak, {
    ...options,
    unauthorized: (message, status) =>
      new KeycloakAdminError("KEYCLOAK_ADMIN_UNAUTHORIZED", message, status),
    unavailable: (message, status) =>
      new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", message, status),
  });
  const keycloak = createKeycloakSpiClient(config.keycloak, { ...options, tokens: spiTokens });
  const keycloakAdmin = createKeycloakOrganizationAdminClient(config.keycloak, {
    ...options,
    tokens: adminTokens,
  });
  const organizationScopes = createOrganizationScopeAdminClient(config.keycloak, {
    ...options,
    tokens: adminTokens,
  });
  const members = createKeycloakOrganizationMembersClient(config.keycloak, {
    ...options,
    tokens: adminTokens,
  });
  const memberRoles = createMemberRoleAdminClient(config.keycloak, { ...options, tokens: adminTokens });
  return {
    firstAdministrator: {
      tenantRealm: config.keycloak.tenantRealm,
      members,
      organizations: keycloakAdmin,
    },
    identityMembers: members,
    memberRoles,
    control: {
      keycloak,
      keycloakAdmin,
      organizationScopes,
      mcpResource: config.mcpResource,
      tenantRealm: config.keycloak.tenantRealm,
    },
  };
}

/** The first loaded module that administers a catalog, if any. */
export function platformCatalogProviderOf(
  modules: readonly RuntimeModule[] | undefined,
): PlatformCatalogProvider | undefined {
  return modules?.find((module) => module.platformCatalog !== undefined)?.platformCatalog;
}

export type CreateControlRuntimeOptions = {
  /** The initialised modules, so the one administering a catalog can be found. */
  modules?: readonly RuntimeModule[] | undefined;
  /** Injected by tests; defaults to reading the process environment. */
  config?: ControlPlaneConfigResult | undefined;
  /** Injected by tests, in place of clients built from the configuration. */
  clients?: PlatformKeycloakClients | undefined;
  /** The bound control Operations; defaults to none, which only whoami's count notices. */
  operations?: readonly OperationContract[] | undefined;
  log?: ((error: unknown) => void) | undefined;
};

export function createControlRuntime(options: CreateControlRuntimeOptions = {}): ControlRuntime {
  const config = options.config ?? readControlPlaneConfig();
  const clients = options.clients ?? (config.ok ? createPlatformKeycloakClients(config.config) : undefined);
  return {
    config,
    ...(clients ? { clients } : {}),
    provider: platformCatalogProviderOf(options.modules),
    operations: options.operations ?? [],
    ...(options.log ? { log: options.log } : {}),
  };
}
