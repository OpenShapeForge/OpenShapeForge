// SPDX-License-Identifier: BUSL-1.1
import manifest from "../generated/db/manifest.json" with { type: "json" };
import { createDatabaseRuntime } from "../db/connection.js";
import { SYSTEM_BYPASS_ROLE, withSystemSession } from "../db/session.js";
import {
  enforceRetention,
  type RetentionManifest,
} from "../retention/retention.js";

const DEFAULT_BATCH_SIZE = 500;

function readBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENSHAPEFORGE_RETENTION_BATCH_SIZE;
  if (raw === undefined) return DEFAULT_BATCH_SIZE;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("OPENSHAPEFORGE_RETENTION_BATCH_SIZE must be an integer between 1 and 10000.");
  }
  return value;
}

export async function runRetentionRole(): Promise<void> {
  const runtime = createDatabaseRuntime({ maxConnections: 1 });
  try {
    const result = await withSystemSession(
      runtime.db,
      {
        actorSubject: "openshapeforge-retention-worker",
        roles: [SYSTEM_BYPASS_ROLE],
        reason: "Enforce compiled retention manifest",
      },
      (trx) => enforceRetention(trx, manifest as unknown as RetentionManifest, {
        batchSize: readBatchSize(),
      }),
    );
    console.log(JSON.stringify({ role: "retention", ...result }));
  } finally {
    await runtime.close();
  }
}
