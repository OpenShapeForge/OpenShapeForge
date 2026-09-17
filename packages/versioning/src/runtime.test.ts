// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { orderSnapshotChildren } from "./runtime.js";

describe("frozen child order", () => {
  test("orders by owned-collection position and breaks ties on id, whatever order the rows arrived in", () => {
    const rows = [
      { id: "c0000000-0000-4000-8000-000000000003", variant_id_position: 1 },
      { id: "b0000000-0000-4000-8000-000000000002", variant_id_position: 0 },
      { id: "a0000000-0000-4000-8000-000000000001", variant_id_position: 1 },
    ];
    const expected = [rows[1]!.id, rows[2]!.id, rows[0]!.id];
    expect(orderSnapshotChildren(rows).map((row) => row.id)).toEqual(expected);
    expect(orderSnapshotChildren([...rows].reverse()).map((row) => row.id)).toEqual(expected);
  });
  test("falls back to id order for collections without a position column", () => {
    const rows = [{ id: "b" }, { id: "a" }, { id: "c" }];
    expect(orderSnapshotChildren(rows).map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(orderSnapshotChildren([])).toEqual([]);
  });
});
