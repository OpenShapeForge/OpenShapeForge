// SPDX-License-Identifier: BUSL-1.1
/**
 * Example compiler plugin: workflow node catalogs.
 *
 * This packages the workflow generators as a standalone plugin instead of a
 * built-in compiler feature; they run behind the web-gated UI path. The plugin
 * owns the whole workflow surface:
 *
 * - `contributePlatformTables` brings back the three global (tenant-agnostic)
 *   workflow catalog tables the generators seed:
 *   `platform.workflow_node_catalog_entries`, `platform.entity_trigger_registry`
 *   and `platform.entity_field_suggestions`.
 * - `generate` runs the workflow generators (`src/workflow-contract.ts` and
 *   friends) against the RESOLVED authoring dir. API-side artifacts (under
 *   `apps/api/src/generated/workflow/`) are always emitted; web-side artifacts
 *   only when `apps/web` exists (`ctx.webPresent`), mirroring how the core
 *   gates its UI artifacts.
 * - `authoring/` next to this module is picked up as an authoring LAYER
 *   automatically: it ships the `workflow-nodes/**` node-config YAMLs plus an
 *   `entityPatch` that restores Relation's `workflow:` block (opting Relation
 *   into entity workflow-node generation).
 *
 * The generators return old-style repo paths (`api/workflow/…`,
 * `workflow/contract/…`); this module maps them to service paths exactly like
 * the core's UI path mapper did. Paths without a mapping are dropped, matching
 * the core's greenfield-safe behavior.
 *
 * The `compiler/` and `generated/compiler/` prefixes carry the web client's
 * copies of the field contract (`field-contract`, `canonical-condition`,
 * `semantic-types`, …). Despite living behind a workflow-named generator these
 * are the *renderer's* core type surface — `@/generated/compiler/field-contract`
 * alone has ~87 importers across `features/renderer` and `components/entity` —
 * so they are mapped and emitted whenever `apps/web` exists. Both prefixes
 * receive byte-identical content (see `workflow-contract.ts`); the duplication
 * is the source repo's, preserved here so the ported imports resolve unchanged.
 */
import type { CompilerPlugin } from "../../../packages/compiler/src/plugins.js";
import type { GeneratedArtifact, TableDefinition } from "../../../packages/compiler/src/schema.js";
import { generateWorkflowContractArtifacts } from "./src/workflow-contract.js";

const API_WORKFLOW_ROOT = "apps/api/src/generated/workflow";
const WEB_WORKFLOW_ROOTS = [
  "apps/web/src/generated/workflow",
  "apps/web/src/features/renderer/generated",
  "apps/web/src/features/workflow/lib/nodes/generated",
];

/**
 * Seed documents for the three platform tables above. The generators emit them
 * under web-side paths because that is where the originating repo's designer
 * read them from, but the tables they feed are API-owned platform tables — so
 * they are mapped API-side and emitted unconditionally, exactly as the core
 * does for the page-config catalog (see `compilerOwnedGeneratedRoots` in
 * `packages/compiler/src/generated-artifact-paths.ts`).
 *
 * Emitting them web-side would mean a host repo that deletes `apps/web` loses
 * the catalogs the API needs to resolve a node type at all.
 *
 * Checked before the prefix mappings; exact paths, so order is not load-bearing.
 */
const seedPathMappings = new Map([
  [
    "features/workflow/lib/nodes/generated/entity-catalog.seed.json",
    `${API_WORKFLOW_ROOT}/entity-catalog.seed.json`,
  ],
  [
    "features/workflow/lib/nodes/generated/entity-trigger-registry.seed.json",
    `${API_WORKFLOW_ROOT}/entity-trigger-registry.seed.json`,
  ],
  [
    "features/renderer/generated/entity-field-suggestions.seed.json",
    `${API_WORKFLOW_ROOT}/entity-field-suggestions.seed.json`,
  ],
]);

const artifactPathMappings = [
  { oldPrefix: "api/workflow/", servicePrefix: `${API_WORKFLOW_ROOT}/` },
  { oldPrefix: "workflow/contract/", servicePrefix: "apps/web/src/generated/workflow/contract/" },
  { oldPrefix: "workflow/generated/", servicePrefix: "apps/web/src/generated/workflow/generated/" },
  {
    oldPrefix: "features/renderer/generated/",
    servicePrefix: "apps/web/src/features/renderer/generated/",
  },
  {
    oldPrefix: "features/workflow/lib/nodes/generated/",
    servicePrefix: "apps/web/src/features/workflow/lib/nodes/generated/",
  },
  // Renderer field-contract copies. `generated/compiler/` must be tested before
  // `compiler/` would ever be reached for the same path, but the prefixes are
  // disjoint so order is not load-bearing; both land inside roots the core
  // already declares in `compilerOwnedGeneratedRoots`.
  { oldPrefix: "generated/compiler/", servicePrefix: "apps/web/src/generated/compiler/" },
  { oldPrefix: "compiler/", servicePrefix: "apps/web/src/compiler/" },
];

function toServicePath(oldCompilerPath: string): string | null {
  const seedPath = seedPathMappings.get(oldCompilerPath);
  if (seedPath) {
    return seedPath;
  }
  for (const { oldPrefix, servicePrefix } of artifactPathMappings) {
    if (oldCompilerPath.startsWith(oldPrefix)) {
      return `${servicePrefix}${oldCompilerPath.slice(oldPrefix.length)}`;
    }
  }
  return null;
}

/**
 * The three workflow catalog tables the plugin contributes to the platform
 * schema. Global, tenant-agnostic compiler-generated platform config — NOT tenant
 * data, so tenantScoped: false (no tenant_id, no RLS), and domainInternal so
 * no generated CRUD/GraphQL surface is emitted for them.
 */
function workflowPlatformTables(): TableDefinition[] {
  return [
    {
      // One row per workflow node type (standard + entity catalogs). The API
      // node-catalog loader reads this at runtime; the generated
      // node-catalog.seed.json is its seed source, keyed by catalog_checksum.
      schema: "platform",
      name: "workflow_node_catalog_entries",
      tenantScoped: false,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "node_type", type: "text", primaryKey: true },
        { name: "catalog", type: "text", required: true }, // 'standard' | 'entity'
        { name: "action", type: "text" },
        { name: "category", type: "text", required: true },
        { name: "label", type: "jsonb", required: true, default: "'{}'::jsonb" },
        { name: "description", type: "jsonb" },
        { name: "config_fields", type: "jsonb", required: true, default: "'[]'::jsonb" },
        { name: "output_fields", type: "jsonb", required: true, default: "'[]'::jsonb" },
        { name: "default_config", type: "jsonb", required: true, default: "'{}'::jsonb" },
        { name: "catalog_checksum", type: "text", required: true },
      ],
      indexes: [
        { name: "workflow_node_catalog_entries_catalog_idx", columns: ["catalog"] },
      ],
    },
    {
      // One row per workflow-triggerable entity: option metadata plus the
      // per-entity filter-field array for the designer's entity-trigger
      // condition builder. Seeded from entity-trigger-registry.seed.json.
      schema: "platform",
      name: "entity_trigger_registry",
      tenantScoped: false,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "id", type: "text", primaryKey: true }, // "<module>:<entity_type>"
        { name: "module", type: "text", required: true },
        { name: "entity", type: "text", required: true }, // PascalCase authoring name
        { name: "entity_type", type: "text", required: true }, // kebab-plural
        { name: "domains", type: "jsonb", required: true, default: "'[]'::jsonb" },
        { name: "label", type: "jsonb", required: true, default: "'{}'::jsonb" },
        { name: "filter_fields", type: "jsonb", required: true, default: "'[]'::jsonb" },
        { name: "checksum", type: "text", required: true },
      ],
      indexes: [
        {
          name: "entity_trigger_registry_module_type_uidx",
          unique: true,
          columns: ["module", "entity_type"],
        },
        { name: "entity_trigger_registry_module_entity_idx", columns: ["module", "entity"] },
        { name: "entity_trigger_registry_checksum_idx", columns: ["checksum"] },
      ],
    },
    {
      // One row per entity (PascalCase name = PK): the Field[] suggestion
      // array behind the renderer's condition/variable pickers. Seeded from
      // entity-field-suggestions.seed.json.
      schema: "platform",
      name: "entity_field_suggestions",
      tenantScoped: false,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "id", type: "text", primaryKey: true }, // PascalCase entity name
        { name: "entity", type: "text", required: true },
        { name: "suggestions", type: "jsonb", required: true, default: "'[]'::jsonb" },
        { name: "checksum", type: "text", required: true },
      ],
      indexes: [
        { name: "entity_field_suggestions_checksum_idx", columns: ["checksum"] },
      ],
    },
  ];
}

/**
 * The workflow data model: definitions and their versions, instances and the
 * per-node state of a run.
 *
 * Unlike the catalogs above these are TENANT DATA, so `tenantScoped: true` and
 * the compiler generates the RLS policy — a workflow definition belongs to the
 * tenant that authored it and must be invisible to every other one, which is
 * the same guarantee every `erp.*` table gets, obtained the same way rather
 * than hand-written here.
 *
 * `domainInternal: true` keeps them off the generated CRUD/GraphQL surface. The
 * generic entity engine would happily expose `createWorkflowDefinition` as a
 * flat column write, and that is precisely wrong: publishing a definition
 * versions it, validates it against the node catalog, and respects an edit
 * lock. The plugin's own resolvers own those invariants.
 */
function workflowDataTables(): TableDefinition[] {
  return [
    {
      // The authored graph's identity and its mutable metadata. The graph
      // itself lives in definition_versions — a definition row survives every
      // edit, so anything referencing "this workflow" points here.
      schema: "workflow",
      name: "definitions",
      tenantScoped: true,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
        { name: "tenant_id", type: "uuid", required: true },
        { name: "name", type: "text", required: true },
        { name: "description", type: "text" },
        // 'process' today. The column exists because a category decides which
        // node types the designer offers, and adding one must not be a migration.
        { name: "category", type: "text", required: true, default: "'process'::text" },
        // Subflow parentage: which node of which definition invokes this one.
        { name: "parent_definition_id", type: "uuid" },
        { name: "parent_node_id", type: "text" },
        // Stable identifier for a definition that arrived from outside this
        // deployment, so re-importing updates rather than duplicates.
        { name: "external_id", type: "text" },
        // Who may run, edit and view this definition. Shape is the plugin's;
        // see `definition-authorization.ts`.
        { name: "authorization", type: "jsonb", required: true, default: "'{}'::jsonb" },
        { name: "is_active", type: "boolean", required: true, default: "true" },
        { name: "created_at", type: "timestamptz", required: true, default: "now()" },
        { name: "updated_at", type: "timestamptz", required: true, default: "now()" },
      ],
      indexes: [
        { name: "workflow_definitions_tenant_name_idx", columns: ["tenant_id", "name"] },
        {
          name: "workflow_definitions_tenant_external_uidx",
          unique: true,
          columns: ["tenant_id", "external_id"],
        },
        { name: "workflow_definitions_parent_idx", columns: ["tenant_id", "parent_definition_id"] },
      ],
    },
    {
      // An immutable snapshot of the graph. A running instance pins the version
      // it started on, so editing a definition cannot change what an in-flight
      // run does — the property that makes a long-lived instance meaningful.
      schema: "workflow",
      name: "definition_versions",
      tenantScoped: true,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
        { name: "tenant_id", type: "uuid", required: true },
        {
          name: "definition_id",
          type: "uuid",
          required: true,
          references: { schema: "workflow", table: "definitions", column: "id", onDelete: "CASCADE" },
        },
        { name: "version", type: "integer", required: true },
        { name: "definition", type: "jsonb", required: true },
        // Null until published: a draft version exists and is editable, a
        // published one is what new instances start from.
        { name: "published_at", type: "timestamptz" },
        { name: "published_by", type: "uuid" },
        { name: "changelog", type: "text" },
        { name: "created_at", type: "timestamptz", required: true, default: "now()" },
      ],
      indexes: [
        {
          name: "workflow_definition_versions_unique_idx",
          unique: true,
          columns: ["tenant_id", "definition_id", "version"],
        },
        {
          name: "workflow_definition_versions_published_idx",
          columns: ["tenant_id", "definition_id", "published_at"],
        },
      ],
    },
    {
      // One run. `version_id` is SET NULL rather than RESTRICT on delete so
      // purging history cannot orphan a completed instance out of existence;
      // `definition_id` is RESTRICT because a definition with runs is not
      // something to delete by accident.
      schema: "workflow",
      name: "instances",
      tenantScoped: true,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
        { name: "tenant_id", type: "uuid", required: true },
        {
          name: "definition_id",
          type: "uuid",
          required: true,
          references: { schema: "workflow", table: "definitions", column: "id", onDelete: "RESTRICT" },
        },
        {
          name: "version_id",
          type: "uuid",
          references: {
            schema: "workflow",
            table: "definition_versions",
            column: "id",
            onDelete: "SET NULL",
          },
        },
        // 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
        { name: "status", type: "text", required: true, default: "'pending'::text" },
        // Immutable start input; process_variables is the mutable scratchpad.
        { name: "context", type: "jsonb", required: true, default: "'{}'::jsonb" },
        { name: "process_variables", type: "jsonb", required: true, default: "'{}'::jsonb" },
        { name: "started_by", type: "uuid" },
        { name: "started_at", type: "timestamptz", required: true, default: "now()" },
        { name: "completed_at", type: "timestamptz" },
        { name: "error", type: "jsonb" },
        // What the run is about, when an entity trigger started it. Text rather
        // than a foreign key: the target is any entity, and a run must outlive
        // the row that triggered it.
        { name: "entity_type", type: "text" },
        { name: "entity_id", type: "text" },
        {
          name: "parent_instance_id",
          type: "uuid",
          references: { schema: "workflow", table: "instances", column: "id", onDelete: "SET NULL" },
        },
        { name: "parent_node_id", type: "text" },
      ],
      indexes: [
        { name: "workflow_instances_tenant_status_idx", columns: ["tenant_id", "status", "started_at"] },
        { name: "workflow_instances_definition_idx", columns: ["tenant_id", "definition_id", "started_at"] },
        { name: "workflow_instances_entity_idx", columns: ["tenant_id", "entity_type", "entity_id"] },
        { name: "workflow_instances_parent_idx", columns: ["tenant_id", "parent_instance_id"] },
      ],
    },
    {
      // Per-node execution record. Both the audit trail and the engine's
      // memory: `{{nodes.<id>.output.<field>}}` placeholders resolve out of
      // shared_output, so this is read during a run, not only after it.
      schema: "workflow",
      name: "node_states",
      tenantScoped: true,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
        { name: "tenant_id", type: "uuid", required: true },
        {
          name: "instance_id",
          type: "uuid",
          required: true,
          references: { schema: "workflow", table: "instances", column: "id", onDelete: "CASCADE" },
        },
        { name: "node_id", type: "text", required: true },
        { name: "node_type", type: "text", required: true },
        // 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped'
        { name: "status", type: "text", required: true },
        { name: "input", type: "jsonb" },
        { name: "resolved_parameters", type: "jsonb" },
        // Split deliberately: shared_output is readable by later nodes through
        // placeholders, private_output is not. A node that handles a secret has
        // somewhere to put it that the graph cannot interpolate into a message.
        { name: "shared_output", type: "jsonb" },
        { name: "private_output", type: "jsonb" },
        { name: "error", type: "jsonb" },
        { name: "started_at", type: "timestamptz" },
        { name: "completed_at", type: "timestamptz" },
      ],
      indexes: [
        { name: "workflow_node_states_instance_idx", columns: ["tenant_id", "instance_id", "started_at"] },
        {
          name: "workflow_node_states_instance_node_idx",
          columns: ["tenant_id", "instance_id", "node_id"],
        },
      ],
    },
    {
      // A pessimistic editor lock, so two people editing one graph do not
      // silently overwrite each other. Optimistic concurrency alone is a poor
      // fit here: a designer session is minutes long and holds a whole graph,
      // so losing the race means losing the work rather than retrying a field.
      //
      // Natural key is (tenant_id, definition_id), but a column can only be
      // declared primaryKey individually and the emitter takes the first one it
      // finds — so a surrogate id carries the PK and a unique index carries the
      // real constraint, which is also what the upsert conflicts on.
      schema: "workflow",
      name: "definition_locks",
      tenantScoped: true,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
        { name: "tenant_id", type: "uuid", required: true },
        {
          name: "definition_id",
          type: "uuid",
          required: true,
          references: { schema: "workflow", table: "definitions", column: "id", onDelete: "CASCADE" },
        },
        // Held by the acquirer and required to release, so a stale browser tab
        // cannot release a lock someone else has since taken over.
        { name: "lock_token", type: "uuid", required: true, default: "gen_random_uuid()" },
        { name: "owner_user_id", type: "text", required: true },
        { name: "acquired_at", type: "timestamptz", required: true, default: "now()" },
        // Expiry rather than an explicit release path: a closed laptop must not
        // lock a definition forever. Refreshed while the editor is open.
        { name: "expires_at", type: "timestamptz", required: true },
      ],
      indexes: [
        {
          name: "workflow_definition_locks_unique_idx",
          unique: true,
          columns: ["tenant_id", "definition_id"],
        },
        { name: "workflow_definition_locks_expiry_idx", columns: ["expires_at"] },
      ],
    },
  ];
}

const plugin: CompilerPlugin = {
  name: "workflow",
  ownedPaths: {
    // The API root is live today; the web roots are declared up front so the
    // stale/orphan gates cover them the moment apps/web returns.
    roots: [API_WORKFLOW_ROOT, ...WEB_WORKFLOW_ROOTS],
  },

  contributePlatformTables() {
    return [...workflowPlatformTables(), ...workflowDataTables()];
  },

  generate({ authoringDir, webPresent }) {
    const files = generateWorkflowContractArtifacts(authoringDir);
    const artifacts: GeneratedArtifact[] = [];
    for (const [oldCompilerPath, contents] of files) {
      const servicePath = toServicePath(oldCompilerPath);
      if (!servicePath) {
        continue; // no mapping (web-client contract duplicates) — not emitted here
      }
      if (!webPresent && !servicePath.startsWith("apps/api/")) {
        continue; // web-side artifacts only exist when apps/web does
      }
      artifacts.push({ path: servicePath, contents });
    }
    return artifacts.sort((a, b) => a.path.localeCompare(b.path));
  },
};

export default plugin;
