// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { getOperationAST, parse, print } from "graphql";
import type { PersistedOperationManifest } from "../yoga.js";

/** A test-owned first-party deployment, independent of the host's web catalog. */
export function persistedOperationFixture(documents: readonly string[]): PersistedOperationManifest {
  const operations: Record<string, string> = {};
  const operationNames: string[] = [];
  for (const document of documents) {
    const parsed = parse(document);
    const name = getOperationAST(parsed)?.name?.value;
    if (!name) throw new Error("A persisted fixture Operation must have a name.");
    const query = print(parsed);
    operations[createHash("sha256").update(query).digest("hex")] = query;
    operationNames.push(name);
  }
  return { operations, operationNames: operationNames.sort() };
}
