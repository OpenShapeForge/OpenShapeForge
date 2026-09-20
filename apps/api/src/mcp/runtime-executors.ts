// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import type {
  RuntimeDeclarativeServiceRequest,
  RuntimeHostOperationRequest,
  RuntimeOperationExecutionResult,
  RuntimeOperationExecutionOptions,
} from "@openshapeforge/plugin-runtime";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { RuntimeModule } from "../modules/contract.js";
import { type ModulePlatformRuntime } from "../modules/platform.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { type GeneratedTable } from "./catalog.js";
import {
  runtimeDeclarativeServiceExecutors,
  runtimeHostOperationExecutors,
} from "./tool-results.js";
import { buildServer } from "./generated-mcp-server.js";

/**
 * Host adapters around the one declarative engine, for the Operation
 * runtime: a declarative Service request and a host Operation each get a
 * server object that only scopes the core catalogue and execution closure to
 * the caller's live Operation session, which stays the authority for
 * database, OAuth, egress and nested Operations. Split out of
 * generated-mcp-server.ts, verbatim.
 */

/**
 * Host adapter around the one declarative engine. It creates no protocol
 * transport: the temporary server object only scopes the existing core
 * catalog/execution closure, while the caller's exact live Operation session
 * remains the authority for database, OAuth, egress and nested Operations.
 */
export function createRuntimeDeclarativeServiceExecutor(input: {
  db: OpenShapeForgeDatabase;
  modules: readonly RuntimeModule[];
  modulePlatform: ModulePlatformRuntime;
  egressOwner?: RuntimeModule["egress"];
  /** @internal Test-only generated-table override. */
  tablesForTests?: Map<string, GeneratedTable>;
}): (
  session: TrustedSessionContext,
  request: RuntimeDeclarativeServiceRequest,
  options?: RuntimeOperationExecutionOptions,
) => Promise<RuntimeOperationExecutionResult> {
  return async (session, request, options) => {
    const server = buildServer(
      input.db,
      session,
      input.modules,
      input.modulePlatform,
      input.egressOwner,
      undefined,
      false,
      input.tablesForTests,
      null,
      session,
    );
    const execute = runtimeDeclarativeServiceExecutors.get(server);
    if (!execute) {
      input.modulePlatform.unregisterServer(server);
      throw new Error("The core declarative Service executor did not initialise.");
    }
    try {
      return await execute(request, randomUUID(), undefined, options?.signal);
    } finally {
      input.modulePlatform.unregisterServer(server);
      runtimeDeclarativeServiceExecutors.delete(server);
    }
  };
}

/**
 * Executes a generated internal compatibility handler by canonical Operation
 * key. The temporary Server scopes existing core state only; no MCP transport
 * or model-visible tool name is created.
 */
export function createRuntimeHostOperationExecutor(input: {
  db: OpenShapeForgeDatabase;
  modules: readonly RuntimeModule[];
  modulePlatform: ModulePlatformRuntime;
  egressOwner?: RuntimeModule["egress"];
}): (
  session: TrustedSessionContext,
  request: RuntimeHostOperationRequest,
  options?: RuntimeOperationExecutionOptions,
) => Promise<RuntimeOperationExecutionResult> {
  return async (session, request, options) => {
    const server = buildServer(
      input.db,
      session,
      input.modules,
      input.modulePlatform,
      input.egressOwner,
      undefined,
      false,
      undefined,
      null,
      session,
    );
    const execute = runtimeHostOperationExecutors.get(server);
    if (!execute) {
      input.modulePlatform.unregisterServer(server);
      throw new Error("The core host Operation executor did not initialise.");
    }
    try {
      return await execute(request, randomUUID(), undefined, options?.signal);
    } finally {
      input.modulePlatform.unregisterServer(server);
      runtimeHostOperationExecutors.delete(server);
      runtimeDeclarativeServiceExecutors.delete(server);
    }
  };
}
