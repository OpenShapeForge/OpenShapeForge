// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SessionCapacity } from "./session-capacity.js";

test("pending sessions consume actor, tenant and global capacity until released", () => {
  const capacity = new SessionCapacity({ total: 3, tenant: 2, actor: 1 });
  const release = capacity.acquire("a", "person");
  expect(() => capacity.acquire("a", "person")).toThrow();
  capacity.acquire("a", "other");
  expect(() => capacity.acquire("a", "third")).toThrow();
  capacity.acquire("b", "person");
  expect(() => capacity.acquire("c", "person")).toThrow();
  release(); release();
  const third = capacity.acquire("c", "person");
  expect(() => capacity.acquire("d", "person")).toThrow();
  third();
  expect(() => capacity.acquire("a", "person")).not.toThrow();
});
