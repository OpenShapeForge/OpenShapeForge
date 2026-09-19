// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-jobs` Operations: an operator's window on platform.jobs, the
 * durable outbox (docs/jobs.md). Declared here as a compiler contribution so
 * they are projected to REST, MCP and GraphQL like any plugin Operation, and
 * bound by the runtime to its own handlers like the blueprint and control
 * Operations are — a deployment with no plugin at all still administers its
 * queue.
 */
import type { CompiledPluginOperation, PluginOperationContract } from "./plugins.js";

export const JOBS_PLUGIN = "osf-jobs";

/** The tenant role that may read and retry jobs; authored in authorization.yaml. */
export const JOBS_MANAGE_ROLE = "Platform.Jobs.Manage";

const titled = (schema: Record<string, unknown>, en: string, nl: string) => ({ ...schema, "x-osf-i18n": { title: { en, nl } } });

const JOB_STATUS = { type: "string", enum: ["queued", "running", "done", "failed", "dead", "outcome_unknown"] };
const UUID = { type: "string", format: "uuid" };
const KIND = { type: "string", pattern: "^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$", maxLength: 200 };
const TIMESTAMP = { type: "string", format: "date-time" };
const NULLABLE_TIMESTAMP = { type: ["string", "null"], format: "date-time" };

const subject = {
  type: "object",
  additionalProperties: false,
  required: ["entity", "id"],
  properties: {
    entity: titled({ type: "string", minLength: 1, maxLength: 200 }, "Entity", "Entiteit"),
    id: titled(UUID, "Record", "Record"),
  },
};

const jobError = {
  type: "object",
  additionalProperties: true,
  required: ["message"],
  properties: {
    code: titled({ type: "string" }, "Code", "Code"),
    message: titled({ type: "string" }, "Message", "Melding"),
    detail: titled({ type: "object", additionalProperties: true }, "Detail", "Detail"),
  },
};

export const JOB_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "kind", "status", "attempts", "maxAttempts", "availableAt", "leaseUntil", "deliveryKey",
    "subject", "lastError", "result", "createdAt", "updatedAt", "completedAt",
  ],
  properties: {
    id: titled(UUID, "Job", "Taak"),
    kind: titled(KIND, "Kind", "Soort"),
    status: titled(JOB_STATUS, "Status", "Status"),
    attempts: titled({ type: "integer", minimum: 0 }, "Attempts", "Pogingen"),
    maxAttempts: titled({ type: "integer", minimum: 1 }, "Attempt limit", "Maximum pogingen"),
    availableAt: titled(TIMESTAMP, "Available at", "Beschikbaar vanaf"),
    leaseUntil: titled(NULLABLE_TIMESTAMP, "Leased until", "Geclaimd tot"),
    deliveryKey: titled({ type: ["string", "null"] }, "Delivery key", "Afleversleutel"),
    subject: titled({ anyOf: [{ type: "null" }, subject] }, "Subject", "Onderwerp"),
    lastError: titled({ anyOf: [{ type: "null" }, jobError] }, "Last error", "Laatste fout"),
    result: titled({ type: ["object", "null"], additionalProperties: true }, "Result", "Resultaat"),
    createdAt: titled(TIMESTAMP, "Created", "Aangemaakt"),
    updatedAt: titled(TIMESTAMP, "Updated", "Bijgewerkt"),
    completedAt: titled(NULLABLE_TIMESTAMP, "Completed", "Afgerond"),
  },
} as const;

const errors: PluginOperationContract["errors"] = [
  { status: 400, code: "BAD_USER_INPUT", description: "The input does not describe a valid request." },
  { status: 401, code: "UNAUTHENTICATED", description: "An authenticated tenant session is required." },
  { status: 403, code: "FORBIDDEN", description: `The ${JOBS_MANAGE_ROLE} role is required.` },
  { status: 404, code: "NOT_FOUND", description: "No job with that id exists in this tenant." },
  { status: 409, code: "CONFLICT", description: "The job is not in a state that can be retried." },
  { status: 503, code: "DATABASE_NOT_CONFIGURED", description: "The database is unavailable." },
];

const auth: PluginOperationContract["auth"] = { mode: "session", roles: [JOBS_MANAGE_ROLE] };
const tenancy: PluginOperationContract["tenancy"] = { mode: "required", description: "Jobs belong to the verified session's tenant." };

const operations: PluginOperationContract[] = [
  {
    key: "jobs.list",
    title: "List jobs",
    description: "Lists the tenant's background jobs, newest first, optionally filtered by kind, status or the record they are about.",
    handler: "list",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: titled(KIND, "Kind", "Soort"),
        status: titled(JOB_STATUS, "Status", "Status"),
        subject: titled(subject, "Subject", "Onderwerp"),
        limit: titled({ type: "integer", minimum: 1, maximum: 100 }, "Limit", "Limiet"),
        cursor: titled({ type: "string", maxLength: 100 }, "Cursor", "Cursor"),
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["items", "nextCursor"],
      properties: {
        items: titled({ type: "array", items: JOB_SCHEMA }, "Jobs", "Taken"),
        nextCursor: titled({ type: ["string", "null"] }, "Next page", "Volgende pagina"),
      },
    },
    errors,
    auth,
    tenancy,
    idempotency: { mode: "intrinsic" },
    effects: { data: "read", external: "none" },
    confirmation: { mode: "none" },
    transports: {
      rest: { method: "POST", path: "/api/jobs/list", response: { kind: "json" } },
      mcp: { enabled: true, name: "jobs_list" },
      graphql: { enabled: true, kind: "query", field: "jobs" },
      typescript: { enabled: false, reason: "Execute through the canonical Operation interface." },
    },
  },
  {
    key: "jobs.get",
    title: "Get a job",
    description: "Reads one background job by id, including its last error and result.",
    handler: "get",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: titled(UUID, "Job", "Taak") } },
    outputSchema: JOB_SCHEMA,
    errors,
    auth,
    tenancy,
    idempotency: { mode: "intrinsic" },
    effects: { data: "read", external: "none" },
    confirmation: { mode: "none" },
    transports: {
      rest: { method: "POST", path: "/api/jobs/get", response: { kind: "json" } },
      mcp: { enabled: true, name: "jobs_get" },
      graphql: { enabled: true, kind: "query", field: "job" },
      typescript: { enabled: false, reason: "Execute through the canonical Operation interface." },
    },
  },
  {
    key: "jobs.retry",
    title: "Retry a job",
    description:
      "Requeues a failed, dead or outcome-unknown job with a fresh attempt budget. For an outcome-unknown job the external effect may already have happened; confirm out of band before retrying, or mark it done instead.",
    handler: "retry",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: titled(UUID, "Job", "Taak"),
        resolution: titled({ type: "string", enum: ["requeue", "done"], default: "requeue" }, "Resolution", "Afhandeling"),
      },
    },
    outputSchema: JOB_SCHEMA,
    errors,
    auth,
    tenancy,
    idempotency: { mode: "none" },
    effects: { data: "write", external: "none" },
    confirmation: { mode: "none" },
    transports: {
      rest: { method: "POST", path: "/api/jobs/retry", response: { kind: "json" } },
      mcp: { enabled: true, name: "jobs_retry" },
      graphql: { enabled: true, kind: "mutation", field: "jobRetry" },
      typescript: { enabled: false, reason: "Execute through the canonical Operation interface." },
    },
  },
];

/** Compiled directly, as the blueprint Operations are: core owns the `jobs` namespace. */
export function collectJobOperations(): CompiledPluginOperation[] {
  return operations.map((operation) => ({ ...operation, plugin: JOBS_PLUGIN, id: operation.key, intent: "invoke" }));
}
