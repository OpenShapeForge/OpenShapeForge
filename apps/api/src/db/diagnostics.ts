// SPDX-License-Identifier: BUSL-1.1
import type { Dialect, KyselyConfig } from "kysely";
import { isOpenTelemetryEnabled, recordDatabaseQuery, withRuntimeSpan } from "@openshapeforge/observability";

/** Preserve the original driver and explicit logger when diagnostics are disabled. */
export function databaseDiagnosticConfig(dialect: Dialect, log?: KyselyConfig["log"]): KyselyConfig {
  if (!isOpenTelemetryEnabled()) return { dialect, ...(log ? { log } : {}) };
  return {
    dialect: {
      createAdapter: () => dialect.createAdapter(),
      createIntrospector: database => dialect.createIntrospector(database),
      createQueryCompiler: () => dialect.createQueryCompiler(),
      createDriver: () => new Proxy(dialect.createDriver(), {
        get(target, property) {
          if (property === "acquireConnection") return () => withRuntimeSpan("database.acquire", () => target.acquireConnection());
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    },
    log: log ?? (event => recordDatabaseQuery(event.queryDurationMillis, event.query.sql, event.level === "error")),
  };
}
