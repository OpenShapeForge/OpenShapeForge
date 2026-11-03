// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, test } from "bun:test";
import { deleteEntity } from "./entity-delete-client";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const call = () => deleteEntity({ mutationName: "deleteRelation", entityId: "id-1", expectedVersion: "v1", confirmed: true });

test("an accepted delete is neither a failure nor a deletion", async () => {
  const accepted = { by: { kind: "workflow", ref: "run-2" }, status: "running" as const };
  globalThis.fetch = (async () => Response.json({ accepted }, { status: 202 })) as unknown as typeof fetch;
  expect(await call()).toEqual({ accepted });
  globalThis.fetch = (async () => Response.json({ deleted: true })) as unknown as typeof fetch;
  expect(await call()).toEqual({ deleted: true });
  globalThis.fetch = (async () => Response.json({ errors: [{ message: "FORBIDDEN: no" }] })) as unknown as typeof fetch;
  await expect(call()).rejects.toThrow("FORBIDDEN: no");
});
