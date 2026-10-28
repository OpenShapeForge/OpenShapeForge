// SPDX-License-Identifier: BUSL-1.1
/**
 * Example compiler plugin: a versioned entity in a schema of its own, plus
 * one plugin Operation beside the entity's own.
 *
 * The plugin has no generators and no platform tables; what it ships is the
 * authoring layer beside it. `Notebook` declares `versioning:
 * publishedSnapshot` from module `notebook`, so its head and version tables
 * live in the `notebook` schema rather than in `erp`. That is the case the
 * generic publish runtime must handle without knowing the entity: the
 * compiler binds the exact storage into the manifest, and
 * `apps/api/src/graphql/__tests__/plugin-versioning.e2e.test.ts` publishes
 * through it and reads the version back.
 *
 * `notebook.import` is the one canonical plugin Operation this repository
 * composes: a keyed command with a REST path parameter, an MCP tool and a
 * GraphQL mutation, bound to the handler in `runtime.ts`. The operations
 * runtime and its transport tests exercise every plugin-Operation path
 * through it — binding, contract validation, idempotency keys and session
 * authorization — which is why it exists here rather than only in a host.
 */
import type { CompilerPlugin } from "../../../packages/compiler/src/plugins.js";
import type { TableDefinition } from "../../../packages/compiler/src/schema.js";

/** The roles that may write a notebook, as the entity itself declares them. */
const NOTEBOOK_WRITER_ROLES = ["Organization.All.ReadWrite"] as const;

/**
 * The plugin's own linked table: one row per accepted external delivery.
 *
 * It belongs to the plugin, not to an entity. It has no generated CRUD, no
 * authoring entity and therefore no ACL of its own — which is the shape the
 * record-action axis has to be able to serve. The rows are children of a
 * Notebook, and what may reach them is decided by asking core whether the
 * session holds `deliver` on that notebook (`platform.records.holdsAction`),
 * in the same transaction and under the same ACL-row lock as the write. There
 * is no second copy of the policy here and no reading of the ACL.
 *
 * `tenantScoped` gives it the tenant policy every contributed table gets, so
 * the axis narrows WITHIN a tenant and never substitutes for the boundary.
 *
 * The unique index is the replay fence, and its columns are the point: the
 * reference is unique per INTEGRATION, which is the stable server-verified
 * principal, and not per key and not per anything the caller chose to call
 * itself. Two concurrent deliveries of one reference therefore collide in the
 * database rather than both committing, across every notebook the
 * integration can reach.
 */
function deliveryTable(): TableDefinition {
  return {
    schema: "notebook",
    name: "notebook_deliveries",
    tenantScoped: true,
    columns: [
      { name: "id", type: "uuid", primaryKey: true, required: true, default: "gen_random_uuid()" },
      { name: "tenant_id", type: "uuid", required: true },
      {
        name: "notebook_id",
        type: "uuid",
        required: true,
        references: {
          schema: "notebook",
          table: "notebooks",
          column: "id",
          onDelete: "CASCADE",
          localColumns: ["tenant_id", "notebook_id"],
          targetColumns: ["tenant_id", "id"],
        },
      },
      // The verified integration the host resolved, never a key id and never
      // request input. Deleting the integration leaves the history readable
      // and the id meaningless, which is the right end state for provenance.
      { name: "integration_id", type: "uuid", required: true },
      { name: "reference", type: "text", required: true },
      // The notebook's name as the action's read projection returned it at
      // the moment the delivery was accepted.
      { name: "notebook_name", type: "text", required: true },
      { name: "created_at", type: "timestamptz", required: true, default: "now()" },
    ],
    indexes: [
      {
        name: "notebook_deliveries_principal_reference_uidx",
        columns: ["tenant_id", "integration_id", "reference"],
        unique: true,
      },
      {
        name: "notebook_deliveries_notebook_idx",
        columns: ["tenant_id", "notebook_id", "integration_id"],
      },
    ],
  };
}

const plugin: CompilerPlugin = {
  name: "notebook",
  contributePlatformTables: () => [deliveryTable()],
  operations: [
    {
      key: "notebook.import",
      title: "Import a notebook body",
      description: "Replaces the body of one draft notebook for the authenticated tenant with a replay-safe idempotency key.",
      handler: "importNotebook",
      inputSchema: {
        type: "object",
        required: ["notebookId", "body", "idempotencyKey"],
        properties: {
          notebookId: { type: "string", format: "uuid" },
          body: { type: "string" },
          idempotencyKey: { type: "string", minLength: 1 },
        },
        additionalProperties: true,
      },
      outputSchema: {
        type: "object",
        required: ["status", "importId", "notebookId"],
        properties: {
          status: { const: "accepted" },
          importId: { type: "string", format: "uuid" },
          notebookId: { type: "string", format: "uuid" },
        },
        additionalProperties: false,
      },
      errors: [
        { status: 400, code: "BAD_USER_INPUT", description: "Invalid notebook import input" },
        { status: 401, code: "UNAUTHENTICATED", description: "Authentication is required" },
        { status: 403, code: "FORBIDDEN", description: "A notebook writer role is required" },
        { status: 404, code: "NOT_FOUND", description: "Notebook not found" },
        { status: 409, code: "CONFLICT", description: "A published notebook takes no import; publish a new draft first" },
        { status: 503, code: "DATABASE_NOT_CONFIGURED", description: "Database is unavailable" },
      ],
      auth: { mode: "session", roles: [...NOTEBOOK_WRITER_ROLES] },
      tenancy: { mode: "required", description: "Tenant comes from the verified OSF session." },
      idempotency: { mode: "idempotency-key", header: "Idempotency-Key", inputField: "idempotencyKey", description: "A sender reuses the key for redelivery of the same import." },
      effects: { data: "write", external: "none" },
      transports: {
        rest: { method: "POST", path: "/api/notebook/import/:notebookId", response: { status: 202, kind: "json" } },
        mcp: { enabled: true, name: "notebook_import" },
        graphql: { enabled: true, kind: "mutation", field: "notebookImport" },
        typescript: { enabled: true, functionName: "importNotebook" },
      },
    },
  ],
};

export default plugin;
