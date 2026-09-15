// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";

const url = process.env.OSF_PREFERENCES_TEST_DATABASE_URL;
test.skipIf(!url)("Bun PostgreSQL JSON binding preserves canonical fields, arrays and scalar overrides", async () => {
  const db = new SQL(url!);
  try {
    for (const [value, type] of [[{ key: "columns", valueType: "string" }, "object"], [["name", "status"], "array"], ["en", "string"], [false, "boolean"], [0, "number"], [null, "null"]] as const) {
      const rows = await db.unsafe("select jsonb_typeof($1::text::jsonb) as type, $1::text::jsonb as value", [JSON.stringify(value)]);
      expect(rows[0].type).toBe(type);
      expect(rows[0].value).toEqual(value);
    }
    const rows = await db.unsafe("select value from jsonb_array_elements_text($1::text::jsonb)", [JSON.stringify(["collection.example:columns", "collection.example:query"])]);
    expect(rows.map((row: { value: string }) => row.value)).toEqual(["collection.example:columns", "collection.example:query"]);
  } finally { await db.close(); }
});
