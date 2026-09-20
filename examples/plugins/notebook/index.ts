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

/** The roles that may write a notebook, as the entity itself declares them. */
const NOTEBOOK_WRITER_ROLES = ["Organization.All.ReadWrite"] as const;

const plugin: CompilerPlugin = {
  name: "notebook",
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
