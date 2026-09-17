// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { planFollow, type FollowBlock } from "./revision-follow.js";

const template = (id: string, templateBlockId: string, key: string, diverged = false): FollowBlock => ({ id, origin: "template", templateBlockId, diverged, key });
const local = (id: string, key = "local"): FollowBlock => ({ id, origin: "local", templateBlockId: null, diverged: false, key });
const previous = new Map([["t1", "one"], ["t2", "two"], ["t3", "three"]]);

describe("the follow-template plan", () => {
  test("re-seeds untouched blocks, keeps edited ones diverged, drops removed ones, inserts new ones", () => {
    const plan = planFollow(
      [template("a", "t1", "one"), template("b", "t2", "two-edited"), template("c", "t3", "three")],
      previous,
      [{ templateBlockId: "t1", key: "one-v2" }, { templateBlockId: "t2", key: "two-v2" }, { templateBlockId: "t4", key: "four" }],
    );
    expect(plan.reseed).toEqual([{ id: "a", templateBlockId: "t1" }]);
    expect(plan.diverge).toEqual(["b"]);
    expect(plan.remove).toEqual(["c"]);
    expect(plan.insert).toEqual(["t4"]);
    expect(plan.order).toEqual([{ kind: "existing", id: "a" }, { kind: "existing", id: "b" }, { kind: "insert", templateBlockId: "t4" }]);
  });
  test("local blocks and edited orphans trail the template block that preceded them", () => {
    const plan = planFollow(
      [local("l0"), template("a", "t1", "one"), local("l1"), template("b", "t2", "two-edited"), template("c", "t3", "three-edited"), local("l2")],
      previous,
      [{ templateBlockId: "t3", key: "three" }, { templateBlockId: "t1", key: "one" }],
    );
    // t2 vanished but was edited: it stays, diverged, right after its former predecessor t1, as does l1.
    expect(plan.diverge).toEqual(["b", "c"]);
    expect(plan.remove).toEqual([]);
    expect(plan.order.map((slot) => (slot.kind === "existing" ? slot.id : `+${slot.templateBlockId}`))).toEqual(["l0", "c", "l2", "a", "l1", "b"]);
  });
  test("a block already flagged diverged is never re-seeded, even when its content still matches", () => {
    const plan = planFollow([template("a", "t1", "one", true)], previous, [{ templateBlockId: "t1", key: "one" }]);
    expect(plan.reseed).toEqual([]);
    expect(plan.diverge).toEqual(["a"]);
  });
  test("a template block unknown to the tracked snapshot counts as edited", () => {
    const plan = planFollow([template("a", "t9", "nine")], previous, []);
    expect(plan.diverge).toEqual(["a"]);
    expect(plan.order).toEqual([{ kind: "existing", id: "a" }]);
  });
  test("a second row claiming the same template block is a local block; the first keeps the slot", () => {
    const plan = planFollow([template("a", "t1", "one"), template("dup", "t1", "one")], previous, [{ templateBlockId: "t1", key: "one-v2" }]);
    expect(plan.reseed).toEqual([{ id: "a", templateBlockId: "t1" }]);
    expect(plan.remove).toEqual([]);
    expect(plan.order).toEqual([{ kind: "existing", id: "a" }, { kind: "existing", id: "dup" }]);
  });
  test("an empty new variant removes every untouched template block and keeps local ones", () => {
    const plan = planFollow([template("a", "t1", "one"), local("l1")], previous, []);
    expect(plan.remove).toEqual(["a"]);
    expect(plan.order).toEqual([{ kind: "existing", id: "l1" }]);
  });
});
