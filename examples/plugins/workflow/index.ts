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
 * the core's UI path mapper did. Unmapped prefixes (`compiler/`,
 * `generated/compiler/` — the web client's duplicate copies of the field
 * contract) are dropped, matching the core's greenfield-safe behavior of
 * skipping paths without a mapping.
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
];

function toServicePath(oldCompilerPath: string): string | null {
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

const plugin: CompilerPlugin = {
  name: "workflow",
  ownedPaths: {
    // The API root is live today; the web roots are declared up front so the
    // stale/orphan gates cover them the moment apps/web returns.
    roots: [API_WORKFLOW_ROOT, ...WEB_WORKFLOW_ROOTS],
  },

  contributePlatformTables() {
    return workflowPlatformTables();
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
