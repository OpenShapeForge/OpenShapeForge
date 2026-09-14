// SPDX-License-Identifier: BUSL-1.1

import type { PluginOperationContract } from "../../packages/compiler/src/plugins.js";

const COMPACT_ERROR_SCHEMA = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
  additionalProperties: false,
} as const;

const REST_ONLY_REASON =
  "The browser session bootstrap is exposed through the REST API only.";

const AVATAR_SCHEMA = {
  type: "object",
  required: ["artifactId", "documentVersionId"],
  properties: {
    artifactId: { type: "string", format: "uuid" },
    documentVersionId: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
} as const;

const SIDEBAR_IDENTITY_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    avatar: AVATAR_SCHEMA,
  },
  additionalProperties: false,
} as const;

/** The verified browser identity used by any OSF product host. */
export const SESSION_OPERATION_CONTRACTS: PluginOperationContract[] = [
  {
    key: "session.get",
    title: "Get the verified session",
    description: "Return the verified tenant, user and roles for the browser session.",
    handler: "getSession",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["tenantId", "userId", "roles", "user", "organisation"],
      properties: {
        tenantId: { type: "string" },
        userId: { type: "string" },
        roles: { type: "array", items: { type: "string" } },
        user: SIDEBAR_IDENTITY_SCHEMA,
        organisation: SIDEBAR_IDENTITY_SCHEMA,
      },
      additionalProperties: false,
    },
    errors: [
      {
        status: 401,
        code: "UNAUTHENTICATED",
        description: "Authentication is required.",
        schema: COMPACT_ERROR_SCHEMA,
        rest: { body: { error: "unauthorized" } },
      },
      {
        status: 503,
        code: "AUTHENTICATION_UNAVAILABLE",
        description: "The verified session profile is unavailable.",
        schema: COMPACT_ERROR_SCHEMA,
        rest: { body: { error: "authentication_unavailable" } },
      },
    ],
    auth: { mode: "session" },
    tenancy: {
      mode: "required",
      description: "The tenant and actor come only from the verified OSF session.",
    },
    idempotency: { mode: "none" },
    transports: {
      rest: {
        method: "GET",
        path: "/api/session",
        response: { status: 200, kind: "json" },
      },
      mcp: { enabled: false, reason: REST_ONLY_REASON },
      graphql: { enabled: false, reason: REST_ONLY_REASON },
      typescript: { enabled: false, reason: REST_ONLY_REASON },
    },
  },
];
