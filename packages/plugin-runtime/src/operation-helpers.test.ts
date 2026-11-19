// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { moduleOperationError, moduleOperationSuccess, queryRows, rawQuery, retryAfterAt, retryAfterMs } from "./index.js";

test("an error result states optional members only when given", () => {
  expect(moduleOperationError(404, "NOT_FOUND", "Gone.")).toEqual({
    ok: false, status: 404, code: "NOT_FOUND", body: { error: { code: "NOT_FOUND", message: "Gone." } },
  });
  expect(moduleOperationError(503, "BUSY", "Later.", { retryable: false, retryAt: "2026-01-01T00:00:00.000Z", detail: "queue" }).body)
    .toEqual({ error: { code: "BUSY", message: "Later.", detail: "queue", retryable: false, retryAt: "2026-01-01T00:00:00.000Z" } });
});

test("a success result projects the same value as text and structured content", () => {
  const value = { id: "a" };
  expect(moduleOperationSuccess(value)).toEqual({
    ok: true, status: 200, value, mcp: { content: [{ type: "text", text: '{"id":"a"}' }], structuredContent: value },
  });
  expect(moduleOperationSuccess(value, { status: 201, pretty: true }).mcp?.content[0].text).toBe('{\n  "id": "a"\n}');
});

test("a raw query carries its parameters in both places an executor may read", async () => {
  const query = rawQuery("select $1::int as n", [1]);
  expect(query.parameters).toEqual([1]);
  expect(query.query).toEqual({ kind: "RawNode", sqlFragments: ["select $1::int as n"], parameters: [1] });
  expect(rawQuery("select 1").queryId.queryId).not.toBe(query.queryId.queryId);
  const seen: unknown[] = [];
  const rows = await queryRows<{ n: number }>({ executeQuery: async (q: unknown) => { seen.push(q); return { rows: [{ n: 1 }] }; } }, "select $1::int as n", [1]);
  expect(rows).toEqual([{ n: 1 }]);
  expect(seen[0]).toMatchObject({ sql: "select $1::int as n", parameters: [1] });
});

test("Retry-After reads delta-seconds and HTTP dates, and nothing else", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  expect(retryAfterMs("120", now)).toBe(120_000);
  expect(retryAfterMs(" 0 ", now)).toBe(0);
  expect(retryAfterMs("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
  expect(retryAfterMs("Wed, 31 Dec 2025 23:59:00 GMT", now)).toBeUndefined();
  for (const bad of [null, undefined, "", "soon", "1.5", "-1", "9".repeat(16), "x".repeat(65)]) expect(retryAfterMs(bad, now)).toBeUndefined();
  expect(retryAfterAt("120", now)).toBe("2026-01-01T00:02:00.000Z");
  expect(retryAfterAt("0", now)).toBeUndefined();
});

test("a horizon discards a later hint, or shortens it when asked to", () => {
  const now = 0;
  expect(retryAfterMs("86401", now, { maxHorizonMs: 86_400_000 })).toBeUndefined();
  expect(retryAfterMs("86400", now, { maxHorizonMs: 86_400_000 })).toBe(86_400_000);
  expect(retryAfterMs("86401", now, { maxHorizonMs: 86_400_000, clamp: true })).toBe(86_400_000);
});
