// SPDX-License-Identifier: BUSL-1.1
/**
 * Explicit, ordered registry of versioned bespoke migrations.
 *
 * Each entry is the default export of a sibling file in this directory,
 * scaffolded with `bun run db:migration:new <kebab-name>`. The runner
 * (../versioned-runner.ts) enforces the "NNNN_kebab-name" version format and
 * strictly ascending numbers, starting at 0002 — 0001 is the generated
 * platform-schema baseline.
 *
 * Applied migrations are immutable: platform.schema_migrations records the
 * sha256 of each migration file and db:migrate fails loudly if an applied
 * file is edited afterwards. Transform forward with a new migration instead.
 */
import type { VersionedMigration } from "../versioned-runner.js";
// migration-registry:imports — `bun run db:migration:new` inserts imports below this line.
import m0009BillingRunItemPeriodOptional from "./0009_billing-run-item-period-optional.js";
import m0008McpHandoffs from "./0008_mcp-handoffs.js";
import m0007DocumentVersionAuthority from "./0007_document-version-authority.js";
import m0006WorkflowNodeCategoryLocalized from "./0006_workflow-node-category-localized.js";
import m0005OrgUnitKeycloakLink from "./0005_org-unit-keycloak-link.js";
import m0003OrgUnitParentTenantGuard from "./0003_org-unit-parent-tenant-guard.js";
import m0004OrgUnitReparentCycleGuard from "./0004_org-unit-reparent-cycle-guard.js";
import m0002OrgUnitClosureTrigger from "./0002_org-unit-closure-trigger.js";

export const versionedMigrations: VersionedMigration[] = [
  m0002OrgUnitClosureTrigger,
  m0003OrgUnitParentTenantGuard,
  m0004OrgUnitReparentCycleGuard,
  m0005OrgUnitKeycloakLink,
  m0006WorkflowNodeCategoryLocalized,
  m0007DocumentVersionAuthority,
  m0008McpHandoffs,
  m0009BillingRunItemPeriodOptional,
  // migration-registry:entries — `bun run db:migration:new` inserts entries above this line.
];
