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
import { WORKFLOW_WORKER_ROLE } from "./worker-role.js";

const API_WORKFLOW_ROOT = "apps/api/src/generated/workflow";

/**
 * Where this plugin's Next.js routes are emitted.
 *
 * `(plugins)` is a route GROUP: parentheses keep it out of the URL, so the
 * emitted page serves `/workflow` and not `/(plugins)/workflow`. Grouping by
 * owner rather than by URL is what makes the root declarable — it is a
 * directory one plugin owns end to end, so the stale/orphan gates can treat
 * anything left in it after the plugin stops emitting as garbage to remove.
 * Routes scattered directly under `app/` could not be swept that way without a
 * gate that knew which of them were plugin-owned.
 *
 * Paired with the `appShellPatch` in `authoring/appShell.yaml`, which is what
 * puts the matching sidebar entry in the generated layout. Drop this plugin
 * from authoring.config.yaml and the route and the nav entry go together.
 */
const WEB_ROUTE_ROOT = "apps/web/src/app/(plugins)/workflow";

/**
 * The route files, each a re-export and nothing else.
 *
 * The pages themselves are hand-written in `web/`, where `typecheck:web` reads
 * them as source rather than as string literals. What is generated is only the
 * fact that the routes exist — which is precisely the part that has to
 * disappear when the plugin is not registered.
 *
 * Two of them, because choosing which definition to edit is a screen of its
 * own: `/workflow` lists them and `/workflow/[id]` is the editor. `[id]` is a
 * Next dynamic segment, so the directory name is load-bearing and the page
 * receives `params`.
 *
 * `module` is the page relative to this plugin; the specifier that reaches it
 * from inside apps/web is computed, because the two routes sit at different
 * depths and hand-counting `../` for each is exactly the kind of thing that is
 * wrong once and then stays wrong.
 */
const WEB_ROUTE_FILES: ReadonlyArray<{ path: string; module: string }> = [
  { path: `${WEB_ROUTE_ROOT}/page.tsx`, module: "web/workflow-page" },
  { path: `${WEB_ROUTE_ROOT}/[id]/page.tsx`, module: "web/workflow-definition-page" },
];

/** Where this plugin sits, from the repo root — the target of every climb below. */
const PLUGIN_ROOT = "examples/plugins/workflow";

/**
 * The specifier a route file uses to reach its page.
 *
 * Climbs out of apps/web and back into examples/, the same reach the runtime
 * half already makes into apps/api. One `../` per directory above the emitted
 * file, derived from the path rather than written out, so a route added at a
 * new depth cannot be off by one.
 */
function webRouteSpecifier(routePath: string, pluginModule: string): string {
  const depth = routePath.split("/").length - 1;
  return `${"../".repeat(depth)}${PLUGIN_ROOT}/${pluginModule}`;
}

const WEB_WORKFLOW_ROOTS = [
  "apps/web/src/generated/workflow",
  "apps/web/src/features/renderer/generated",
  "apps/web/src/features/workflow/lib/nodes/generated",
  WEB_ROUTE_ROOT,
];

/** One re-export per emitted route; the header explains why it is this thin. */
function webRouteArtifacts(): GeneratedArtifact[] {
  return WEB_ROUTE_FILES.map((route) => ({
    path: route.path,
    contents:
      "// SPDX-License-Identifier: BUSL-1.1\n" +
      "// Generated by the workflow plugin. The page lives in the plugin's web/\n" +
      "// half; this file only declares that the route exists.\n" +
      `export { default } from "${webRouteSpecifier(route.path, route.module)}";\n`,
  }));
}

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
      // One row per workflow node type, across all three catalogs — this
      // plugin seeds `standard` and `entity`, the domain node packs seed
      // `domain` into the same table. The API node-catalog loader reads the
      // union at runtime; the generated node-catalog.seed.json is this
      // plugin's seed source, keyed by catalog_checksum.
      schema: "platform",
      name: "workflow_node_catalog_entries",
      tenantScoped: false,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "node_type", type: "text", primaryKey: true },
        { name: "catalog", type: "text", required: true }, // 'standard' | 'entity' | 'domain'
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
        // Snapshot of what was published when the run started. Denormalised on
        // purpose: a definition can be renamed or its version purged, and an
        // instance list must still say what ran.
        { name: "definition_version", type: "integer" },
        { name: "definition_name", type: "text" },
        // How the run was started, and whatever the trigger knew at the time.
        { name: "trigger_type", type: "text" },
        { name: "trigger_meta", type: "jsonb" },
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

/**
 * The execution plane: how a run is asked to move, and what it is waiting for.
 *
 * These are separate from the authoring tables above because they are written
 * by workers rather than by people, and their access pattern is a queue rather
 * than a document store.
 *
 * The design commitment worth stating: **an intent to run is a row, not a call.**
 * Starting, resuming and cancelling all go through `control_commands`, claimed
 * with `for update skip locked`, so a crashed worker loses nothing and a
 * duplicate request is absorbed by an idempotency key rather than starting a
 * second run. That is also what lets the durable-execution service be optional
 * — the queue is the durability, and an external dispatcher is one
 * implementation of draining it.
 *
 * Claiming is cross-tenant by nature — one worker drains every tenant's backlog
 * — so exactly the three tables a claim touches declare
 * `workerAccess: WORKFLOW_WORKER_ROLE`. That widens their policy to admit a
 * session holding `app.worker_role`, and nothing else in the manifest moves. It
 * replaces `app.bypass_rls`, which would have granted the same worker read and
 * write on every tenant's business data to let it read a queue.
 *
 * `waits` and `collection_waits` are on the list for the same reason, though
 * they are not a command queue. The collection-wait sweeps are their own poll
 * loop: they scan every tenant's pending waits to find which ones an event has
 * satisfied, and which have timed out. That scan is the claim, and it is
 * cross-tenant by exactly the same argument. What it finds is then handed to a
 * session scoped to that wait's own tenant to do the resuming — so the widening
 * buys the sweep its scan and nothing more.
 *
 * Note which tables are NOT on the list: `instances` and `node_states` are
 * reached only after a wait or a command is claimed, from a session scoped to
 * that tenant, so they need no widening at all. The cross-tenant surface is the
 * queue, not the work — which is why the stalled-wait counter in
 * `runtime/collection-waits.ts` resolves its tenants first and only then reads
 * instance status per tenant, rather than joining `instances` in one sweep.
 */
function workflowExecutionTables(): TableDefinition[] {
  return [
    {
      // The command queue. Every state change to a run enters here first.
      schema: "workflow",
      name: "control_commands",
      tenantScoped: true,
      // Claimed across tenants by the control-command worker.
      workerAccess: WORKFLOW_WORKER_ROLE,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
        { name: "tenant_id", type: "uuid", required: true },
        // 'workflow.instance.start' | '.resume' | '.cancel'
        { name: "command_type", type: "text", required: true },
        {
          name: "workflow_instance_id",
          type: "uuid",
          references: { schema: "workflow", table: "instances", column: "id", onDelete: "CASCADE" },
        },
        { name: "payload", type: "jsonb", required: true, default: "'{}'::jsonb" },
        // Deduplicates a retried enqueue: two commands cannot hold one key, so
        // the caller that loses adopts the run the winner enqueued instead of
        // opening a second one. Only a caller able to name the delivery can
        // supply a key — the webhook route takes the sender's `Idempotency-Key`
        // header, and a delivery carrying none starts a run per delivery.
        // Schedules do not use this column; `schedule_fires` keys the occurrence
        // itself, which is the fact a schedule can name and a key cannot.
        { name: "idempotency_key", type: "text" },
        // Every state a row can hold:
        //   'pending'          waiting for a worker, or waiting out the backoff
        //                      after a dispatch failed — `next_attempt_at` says
        //                      which.
        //   'processing'       claimed by `locked_by` at `locked_at`, and owed
        //                      an outcome by whoever holds it.
        //   'runtime_consumed' the runtime took the command inside the
        //                      transaction that did the work, and that
        //                      transaction committed. The worker normally
        //                      reports back at once and the row becomes
        //                      'completed'; a worker that dies in between leaves
        //                      it here for good — never reclaimed, because the
        //                      work happened, and never reconciled either. A row
        //                      sitting at this status is a dead worker, not a
        //                      run that was missed.
        //   'completed'        dispatched, and the worker recorded it.
        //   'failed'           terminal, from either end of the attempt bound:
        //                      the dispatcher threw on the last attempt, or the
        //                      claim closed a row that reached the bound without
        //                      any worker reporting back. `last_error` says
        //                      which.
        { name: "status", type: "text", required: true, default: "'pending'::text" },
        { name: "attempts", type: "integer", required: true, default: "0" },
        { name: "next_attempt_at", type: "timestamptz" },
        // Claim marker. `locked_at` also drives reclaim: a worker that died
        // mid-command leaves the row processing, and the age of the claim is
        // the only evidence available that nobody is still working on it.
        { name: "locked_at", type: "timestamptz" },
        { name: "locked_by", type: "text" },
        { name: "last_error", type: "text" },
        { name: "created_at", type: "timestamptz", required: true, default: "now()" },
        { name: "updated_at", type: "timestamptz", required: true, default: "now()" },
      ],
      indexes: [
        {
          name: "workflow_control_commands_pending_idx",
          columns: ["status", "next_attempt_at", "created_at"],
        },
        {
          name: "workflow_control_commands_idempotency_uidx",
          unique: true,
          columns: ["tenant_id", "idempotency_key"],
        },
        { name: "workflow_control_commands_instance_idx", columns: ["tenant_id", "workflow_instance_id"] },
      ],
    },
    {
      // A node that stopped and is waiting to be told to continue: a human
      // decision, an inbound signal, a timer. One row per parked node.
      schema: "workflow",
      name: "waits",
      tenantScoped: true,
      // Read across tenants by the collection-wait sweeps, which join it to
      // read `wait_metadata` while deciding which pending waits to replay, and
      // claimed across tenants by the timer sweep, which updates `resumed_at`
      // on rows whose `resume_at` has passed. Both are claims on the wait
      // itself; the resuming they lead to runs in the wait's own tenant.
      workerAccess: WORKFLOW_WORKER_ROLE,
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
        { name: "node_label", type: "text" },
        // Opaque to the engine and required to resume, so a stale client cannot
        // resume a wait that has since been superseded.
        { name: "wait_token", type: "text", required: true },
        { name: "wait_kind", type: "text", required: true },
        { name: "instructions", type: "text" },
        // What the resumer must supply, and whatever has been gathered so far.
        { name: "fields", type: "jsonb" },
        { name: "partial_input", type: "jsonb" },
        { name: "wait_metadata", type: "jsonb" },
        { name: "assigned_to", type: "text" },
        // When this parked node becomes due, and the claim that retires it.
        //
        // "Resume this node at a wall-clock time" is not specific to the timer
        // node — a join timeout wants the same two columns — so it lives on the
        // generic parked-node table rather than in a table per wait kind. Only
        // the timer bridge writes `resume_at` today, and only its sweep writes
        // `resumed_at`; both are null for every other kind, which is why the
        // sweep filters on `resume_at is not null` rather than on the kind
        // alone.
        //
        // `resumed_at` exists so the sweep can CLAIM. Without it the same row
        // is re-selected on every tick forever: the resume command would dedupe
        // on its idempotency key, so nothing breaks, but the row is never
        // retired and the scan grows without bound.
        { name: "resume_at", type: "timestamptz" },
        { name: "resumed_at", type: "timestamptz" },
        { name: "created_at", type: "timestamptz", required: true, default: "now()" },
        { name: "updated_at", type: "timestamptz", required: true, default: "now()" },
      ],
      indexes: [
        { name: "workflow_waits_tenant_token_uidx", unique: true, columns: ["tenant_id", "wait_token"] },
        { name: "workflow_waits_instance_idx", columns: ["tenant_id", "instance_id"] },
        { name: "workflow_waits_resume_idx", columns: ["wait_kind", "resume_at"] },
      ],
    },
    {
      // A wait on something happening elsewhere in the platform, matched against
      // the entity-event journal.
      //
      // `checkpoint_sequence` is what makes this correct rather than racy: the
      // wait records the journal position it was registered at, so an event that
      // fired between the decision to wait and the row being written is still
      // matched by replaying forward from the checkpoint. Without it, the gap
      // between those two moments silently loses events.
      schema: "workflow",
      name: "collection_waits",
      tenantScoped: true,
      // Scanned and timed out across tenants by the collection-wait sweeps.
      // That scan is this table's claim; the resuming it leads to happens in a
      // session scoped to the wait's own tenant.
      workerAccess: WORKFLOW_WORKER_ROLE,
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
        { name: "wait_token", type: "text", required: true },
        { name: "entity_type", type: "text", required: true },
        { name: "event_type", type: "text", required: true },
        { name: "filters", type: "jsonb", required: true, default: "'{}'::jsonb" },
        { name: "filter_hash", type: "text", required: true },
        { name: "checkpoint_sequence", type: "bigint", required: true, default: "0" },
        // 'pending' | 'matched' | 'timed_out'
        { name: "status", type: "text", required: true, default: "'pending'::text" },
        { name: "matched_event_id", type: "uuid" },
        { name: "matched_sequence", type: "bigint" },
        { name: "timeout_at", type: "timestamptz" },
        { name: "created_at", type: "timestamptz", required: true, default: "now()" },
        { name: "updated_at", type: "timestamptz", required: true, default: "now()" },
      ],
      indexes: [
        {
          name: "workflow_collection_waits_tenant_token_uidx",
          unique: true,
          columns: ["tenant_id", "wait_token"],
        },
        {
          name: "workflow_collection_waits_pending_idx",
          columns: ["tenant_id", "status", "entity_type", "event_type", "checkpoint_sequence"],
        },
        { name: "workflow_collection_waits_timeout_idx", columns: ["status", "timeout_at"] },
      ],
    },
    {
      // One row per published definition that carries a schedule trigger.
      // Derived state, rebuilt on publish — never authored directly.
      schema: "workflow",
      name: "schedules",
      tenantScoped: true,
      // Scanned across tenants by the schedule worker for due rows.
      workerAccess: WORKFLOW_WORKER_ROLE,
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
        { name: "trigger_node_id", type: "text" },
        { name: "cron", type: "text" },
        { name: "timezone", type: "text" },
        { name: "started_by", type: "uuid" },
        // 'active' | 'inactive'
        { name: "status", type: "text", required: true, default: "'active'::text" },
        // Bumped whenever the definition republishes. A fire computed against an
        // older generation is discarded rather than started, so an edit cannot
        // leave a stale cron running.
        { name: "generation", type: "integer", required: true, default: "1" },
        { name: "next_fire_at", type: "timestamptz" },
        { name: "next_occurrence", type: "integer", required: true, default: "1" },
        { name: "last_fired_at", type: "timestamptz" },
        { name: "last_result", type: "jsonb", required: true, default: "'{}'::jsonb" },
        { name: "locked_at", type: "timestamptz" },
        { name: "locked_by", type: "text" },
        { name: "created_at", type: "timestamptz", required: true, default: "now()" },
        { name: "updated_at", type: "timestamptz", required: true, default: "now()" },
      ],
      indexes: [
        {
          name: "workflow_schedules_definition_uidx",
          unique: true,
          columns: ["tenant_id", "definition_id"],
        },
        { name: "workflow_schedules_due_idx", columns: ["status", "next_fire_at"] },
      ],
    },
    {
      // The ledger that makes a scheduled start exactly-once. A fire is recorded
      // before the command is enqueued, and the unique index on the occurrence is
      // what refuses the second attempt — so two workers racing the same due row,
      // or one worker retried after a crash, still produce one run.
      schema: "workflow",
      name: "schedule_fires",
      tenantScoped: true,
      // Written by the schedule worker in the same claim, before the tenant is
      // known well enough to open a tenant-scoped session on it.
      workerAccess: WORKFLOW_WORKER_ROLE,
      domainInternal: true,
      generatedCrud: false,
      columns: [
        { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
        { name: "tenant_id", type: "uuid", required: true },
        {
          name: "schedule_id",
          type: "uuid",
          required: true,
          references: { schema: "workflow", table: "schedules", column: "id", onDelete: "CASCADE" },
        },
        {
          name: "definition_id",
          type: "uuid",
          required: true,
          references: { schema: "workflow", table: "definitions", column: "id", onDelete: "CASCADE" },
        },
        // Which published graph this fire ran. A fire is a ledger entry, and
        // without this it cannot say what it started — `definition_id` names the
        // definition but not the version, and a definition's graph changes.
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
        { name: "trigger_node_id", type: "text", required: true },
        { name: "scheduled_at", type: "timestamptz", required: true },
        { name: "occurrence", type: "integer", required: true },
        { name: "idempotency_key", type: "text", required: true },
        {
          name: "workflow_instance_id",
          type: "uuid",
          references: { schema: "workflow", table: "instances", column: "id", onDelete: "SET NULL" },
        },
        // The start command this fire enqueued. Written after the insert, by the
        // same claim: the row is the fire's record that the start was queued, so
        // a fire that committed without one is a worker that died between the
        // two statements. Nullable for that window, and SET NULL rather than
        // CASCADE because losing the command must not erase the fire.
        {
          name: "command_id",
          type: "uuid",
          references: {
            schema: "workflow",
            table: "control_commands",
            column: "id",
            onDelete: "SET NULL",
          },
        },
        { name: "status", type: "text", required: true, default: "'started'::text" },
        { name: "created_at", type: "timestamptz", required: true, default: "now()" },
      ],
      indexes: [
        {
          name: "workflow_schedule_fires_occurrence_uidx",
          unique: true,
          columns: ["tenant_id", "definition_id", "scheduled_at", "occurrence"],
        },
        {
          name: "workflow_schedule_fires_idempotency_uidx",
          unique: true,
          columns: ["tenant_id", "idempotency_key"],
        },
        { name: "workflow_schedule_fires_schedule_idx", columns: ["tenant_id", "schedule_id", "scheduled_at"] },
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
    return [
      ...workflowPlatformTables(),
      ...workflowDataTables(),
      ...workflowExecutionTables(),
    ];
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
    if (webPresent) {
      // Same gate as every other web-side artifact: a repo with no apps/web
      // gets the engine and no screens, rather than a route file pointing at a
      // directory that is not there.
      artifacts.push(...webRouteArtifacts());
    }
    return artifacts.sort((a, b) => a.path.localeCompare(b.path));
  },
};

export default plugin;
