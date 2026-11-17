// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { TemplateContentError } from "./errors.js";
import {
  blockHash, holdsProtectedContent, inclusionCopyContent, mergeInclusionCopy, normalizeLocalDraft, readInclusionCopy, sourceRecord,
  type CompositionOf, type InclusionCopy,
} from "./inclusion-copy.js";
import type { ContentBlock, JsonObject } from "./index.js";

const compositionOf: CompositionOf = (key) => key === "Slot" ? { templateVersionField: "version", parametersField: "parameters" } : undefined;
const text = (id: string, markdown: string, locked = false): ContentBlock => ({ id, definitionKey: "Text", schemaVersion: 1, values: { markdown }, references: {}, ...(locked ? { locked: true as const } : {}) });
const copyOf = async (blocks: readonly ContentBlock[], page?: JsonObject): Promise<InclusionCopy> => ({ ...(page ? { page } : {}), source: await sourceRecord(blocks), blocks });
const slot = (id: string, copy: InclusionCopy, version = "inner-v1"): ContentBlock => ({ id, definitionKey: "Slot", schemaVersion: 1, values: { parameters: {}, content: inclusionCopyContent(copy) }, references: { version: { entity: "TemplateVersion", id: version } } });
const bodies = (blocks: readonly ContentBlock[]) => blocks.map((block) => `${block.id}:${block.values.markdown ?? "…"}`);
const draft = (copy: InclusionCopy, change: (blocks: Record<string, unknown>[]) => Record<string, unknown>[] = (blocks) => blocks) => {
  const content = structuredClone(inclusionCopyContent(copy)) as { blocks: Record<string, unknown>[] } & Record<string, unknown>;
  return { ...content, blocks: change(content.blocks) };
};
async function conflicts(work: Promise<unknown>, message: string) {
  const error = await work.then(() => undefined, (caught) => caught);
  expect(error).toBeInstanceOf(TemplateContentError);
  expect((error as Error).message).toContain(message);
  expect((error as Error).message).toContain("The existing inclusion has been kept.");
}

describe("the stored copy", () => {
  test("round-trips through its stored form and states every source lock on the block", async () => {
    const copy = await copyOf([text("a", "A", true), text("b", "B")], { format: "a4" });
    const stored = inclusionCopyContent(copy);
    expect((stored.blocks as unknown as ContentBlock[]).map((block) => block.locked)).toEqual([true, undefined]);
    expect(readInclusionCopy(stored)).toEqual(copy);
  });

  test("hashes the content of a block, not who protects it nor the source record nested in it", async () => {
    const plain = await blockHash(text("a", "A"));
    expect(await blockHash(text("a", "A", true))).toBe(plain);
    expect(await blockHash(text("a", "Other"))).not.toBe(plain);
    const inner = await copyOf([text("x", "X")]);
    const rebased: InclusionCopy = { ...inner, source: [{ id: "x", hash: "f".repeat(64), locked: true }] };
    expect(await blockHash(slot("s", rebased))).toBe(await blockHash(slot("s", inner)));
    expect(await blockHash(slot("s", await copyOf([text("x", "Changed")])))).not.toBe(await blockHash(slot("s", inner)));
  });

  test("refuses a malformed source record instead of reading around it", () => {
    for (const source of [[{ id: "a" }], [{ id: "a", hash: "short" }], [{ id: "a", hash: "0".repeat(64), extra: 1 }], [{ id: "a", hash: "0".repeat(64) }, { id: "a", hash: "0".repeat(64) }]])
      expect(() => readInclusionCopy({ source, blocks: [] })).toThrow(TemplateContentError);
  });
});

describe("a caller's draft against the stored baseline", () => {
  test("accepts edits, additions and removals of unprotected blocks and keeps the server's record", async () => {
    const stored = await copyOf([text("a", "A"), text("b", "B", true), text("c", "C")]);
    const blocks = await normalizeLocalDraft(stored, draft(stored, (rows) => [{ ...rows[0]!, values: { markdown: "A edited" } }, rows[1]!, { id: "mine", definitionKey: "Text", schemaVersion: 1, values: { markdown: "Mine" } }]), { compositionOf });
    expect(bodies(blocks)).toEqual(["a:A edited", "b:B", "mine:Mine"]);
    expect(blocks.map((block) => block.locked)).toEqual([undefined, true, undefined]);
  });

  test("refuses a forged or reset source record, changed page settings and a lowered or invented lock", async () => {
    const stored = await copyOf([text("a", "A", true), text("b", "B")], { format: "a4" });
    const edited = await blockHash(text("a", "Forged"));
    const attempts: unknown[] = [
      { ...draft(stored), source: [{ id: "a", hash: edited, locked: true }, stored.source[1]] },
      { ...draft(stored), source: [{ id: "a", hash: stored.source[0]!.hash }, stored.source[1]] },
      { ...draft(stored), source: [] },
      { ...draft(stored), page: { format: "letter" } },
      draft(stored, (rows) => [{ ...rows[0]!, locked: false }, rows[1]!]),
      draft(stored, (rows) => [rows[0]!, { ...rows[1]!, locked: true }]),
      { ...draft(stored), baseline: [] },
    ];
    for (const attempt of attempts) await expect(normalizeLocalDraft(stored, attempt, { compositionOf })).rejects.toBeInstanceOf(TemplateContentError);
    // A draft that leaves the server's record out, or sends it back as read, is an ordinary edit.
    const { source: _source, page: _page, ...bare } = draft(stored) as Record<string, unknown>;
    expect(bodies(await normalizeLocalDraft(stored, bare, { compositionOf }))).toEqual(["a:A", "b:B"]);
    expect(bodies(await normalizeLocalDraft(stored, draft(stored), { compositionOf }))).toEqual(["a:A", "b:B"]);
  });

  test("refuses changing, removing or reordering a locked block", async () => {
    const stored = await copyOf([text("a", "A", true), text("b", "B", true), text("c", "C")]);
    for (const change of [
      (rows: Record<string, unknown>[]) => [{ ...rows[0]!, values: { markdown: "Changed" } }, rows[1]!, rows[2]!],
      (rows: Record<string, unknown>[]) => [rows[1]!, rows[2]!],
      (rows: Record<string, unknown>[]) => [rows[1]!, rows[0]!, rows[2]!],
      (rows: Record<string, unknown>[]) => [rows[0]!, rows[1]!, { ...rows[0]!, values: { markdown: "Twice" } }],
    ]) await expect(normalizeLocalDraft(stored, draft(stored, change), { compositionOf })).rejects.toBeInstanceOf(TemplateContentError);
    // An unprotected block may move between the locked ones.
    expect(bodies(await normalizeLocalDraft(stored, draft(stored, (rows) => [rows[0]!, rows[2]!, rows[1]!]), { compositionOf }))).toEqual(["a:A", "c:C", "b:B"]);
  });

  test("refuses removing or replacing an enclosing inclusion while content nested in it is protected", async () => {
    const guarded = slot("inner", await copyOf([text("deep", "Deep", true)]));
    const open = slot("free", await copyOf([text("loose", "Loose")]));
    const stored = await copyOf([guarded, open]);
    expect(holdsProtectedContent(stored, compositionOf)).toBe(true);
    await expect(normalizeLocalDraft(stored, draft(stored, (rows) => [rows[1]!]), { compositionOf })).rejects.toThrow("enclosing block");
    await expect(normalizeLocalDraft(stored, draft(stored, (rows) => [{ id: "inner2", definitionKey: "Text", schemaVersion: 1, values: { markdown: "Replacement" } }, rows[1]!]), { compositionOf })).rejects.toThrow("enclosing block");
    // Reaching into the nested copy needs the boundary that can settle it; without one it must be stored unchanged.
    const reached = draft(stored, (rows) => [{ ...rows[0]!, values: { parameters: {}, content: { source: [], blocks: [] } } }, rows[1]!]);
    await expect(normalizeLocalDraft(stored, reached, { compositionOf })).rejects.toBeInstanceOf(TemplateContentError);
    expect((await normalizeLocalDraft(stored, draft(stored, (rows) => [rows[0]!]), { compositionOf })).map((block) => block.id)).toEqual(["inner"]);
  });

  test("refuses turning an inclusion that holds protected content into another kind of block under the same identity", async () => {
    const guarded = slot("inner", await copyOf([text("deep", "Deep", true)]));
    const deeper = slot("outer", await copyOf([slot("middle", await copyOf([text("deepest", "Deepest", true)]))]));
    const stored = await copyOf([guarded, deeper, slot("free", await copyOf([text("loose", "Loose")]))]);
    const asText = (id: string) => ({ id, definitionKey: "Text", schemaVersion: 1, values: { markdown: "Replacement" }, references: {} });
    const settleNested = async (input: { draft: ContentBlock }) => input.draft;
    for (const options of [{ compositionOf }, { compositionOf, settleNested }]) {
      // The same id as another definition: there is no interior left to hold the protected block, one level down or two.
      await expect(normalizeLocalDraft(stored, draft(stored, (rows) => [asText("inner"), rows[1]!, rows[2]!]), options)).rejects.toThrow("enclosing block");
      await expect(normalizeLocalDraft(stored, draft(stored, (rows) => [rows[0]!, asText("outer"), rows[2]!]), options)).rejects.toThrow("enclosing block");
    }
    // A settlement that hands back an inclusion without the protected block does not get it past the stored record either.
    const emptied = async (input: { draft: ContentBlock }) => input.draft.id === "inner" ? slot("inner", await copyOf([text("else", "Else")])) : input.draft;
    await expect(normalizeLocalDraft(stored, draft(stored), { compositionOf, settleNested: emptied })).rejects.toThrow("enclosing block");
    // An inclusion that protects nothing may become anything.
    expect((await normalizeLocalDraft(stored, draft(stored, (rows) => [rows[0]!, rows[1]!, asText("free")]), { compositionOf })).map((block) => block.definitionKey)).toEqual(["Slot", "Slot", "Text"]);
  });

  test("over a baseline captured in the same write, protected blocks come from the baseline and the draft's record is ignored", async () => {
    const fresh = await copyOf([text("a", "Fresh A", true), text("b", "Fresh B")]);
    const stale = { source: [{ id: "a", hash: "0".repeat(64) }], blocks: [{ id: "a", definitionKey: "Text", schemaVersion: 1, values: { markdown: "Stale A" } }, { id: "b", definitionKey: "Text", schemaVersion: 1, values: { markdown: "My B" } }] };
    expect(bodies(await normalizeLocalDraft(fresh, stale, { compositionOf, freshBaseline: true }))).toEqual(["a:Fresh A", "b:My B"]);
    await expect(normalizeLocalDraft(fresh, { blocks: [stale.blocks[1]] }, { compositionOf, freshBaseline: true })).rejects.toThrow("cannot be removed");
  });
});

describe("the three-way update", () => {
  const authored = [text("a", "Dear {{local.name}}"), text("b", "Terms"), text("c", "Closing")];

  test("refreshes untouched text and keeps a local edit when only a record value moved", async () => {
    const stored = await copyOf([text("a", "Dear Ada"), text("b", "Terms"), text("c", "Closing")]);
    const captured = await copyOf([text("a", "Dear Grace"), text("b", "Terms"), text("c", "Closing")]);
    const untouched = await mergeInclusionCopy({ baseline: stored.source, current: stored.blocks, authoredOld: authored, authoredNew: authored, captured, compositionOf });
    expect(bodies(untouched.blocks)).toEqual(["a:Dear Grace", "b:Terms", "c:Closing"]);
    const edited = [text("a", "Dear Ada, welcome"), stored.blocks[1]!, stored.blocks[2]!];
    const merged = await mergeInclusionCopy({ baseline: stored.source, current: edited, authoredOld: authored, authoredNew: authored, captured, compositionOf });
    expect(bodies(merged.blocks)).toEqual(["a:Dear Ada, welcome", "b:Terms", "c:Closing"]);
    // The baseline and page settings advance to the new capture, so the kept text still counts as a local change.
    expect(merged.source).toEqual(captured.source);
    expect(merged.source[0]!.hash).not.toBe(await blockHash(merged.blocks[0]!));
  });

  test("adopts source changes, insertions and removals around local additions and removals", async () => {
    const stored = await copyOf([text("a", "A"), text("b", "B"), text("c", "C"), text("d", "D")]);
    const next = [text("a", "A"), text("n", "New"), text("b", "B2"), text("d", "D")];
    const current = [stored.blocks[0]!, text("mine", "Mine"), stored.blocks[1]!, stored.blocks[2]!];
    const merged = await mergeInclusionCopy({ baseline: stored.source, current, authoredOld: stored.blocks, authoredNew: next, captured: await copyOf(next, { format: "a5" }), compositionOf });
    // `d` was removed here and stays removed; `c` left the source untouched and goes; `mine` trails the block it followed.
    expect(bodies(merged.blocks)).toEqual(["a:A", "mine:Mine", "n:New", "b:B2"]);
    expect(merged.page).toEqual({ format: "a5" });
    const again = await mergeInclusionCopy({ baseline: merged.source, current: merged.blocks, authoredOld: next, authoredNew: next, captured: await copyOf(next, { format: "a5" }), compositionOf });
    // Repeating the update neither duplicates nor resurrects anything.
    expect(bodies(again.blocks)).toEqual(bodies(merged.blocks));
  });

  test("keeps a locally changed block the source dropped, as local content", async () => {
    const stored = await copyOf([text("a", "A"), text("b", "B")]);
    const merged = await mergeInclusionCopy({ baseline: stored.source, current: [text("a", "A mine"), text("b", "B"), text("x", "X")], authoredOld: stored.blocks, authoredNew: [], captured: await copyOf([]), compositionOf });
    expect(merged.blocks).toEqual([text("a", "A mine"), text("x", "X")]);
  });

  test("never drops content the stored copy protects: a new source that omits it is refused", async () => {
    // A locked block the new source no longer has.
    const stored = await copyOf([text("a", "A"), text("b", "B", true)]);
    const without = [text("a", "A2")];
    await conflicts(mergeInclusionCopy({ baseline: stored.source, current: stored.blocks, authoredOld: stored.blocks, authoredNew: without, captured: await copyOf(without), compositionOf }), "no longer holds content that is protected here");
    // An unchanged, unlocked inclusion whose copy holds a locked block, omitted by the new source.
    const wrapper = slot("wrap", await copyOf([text("clause", "Clause", true)]));
    const holding = await copyOf([text("a", "A"), wrapper]);
    await conflicts(mergeInclusionCopy({ baseline: holding.source, current: holding.blocks, authoredOld: holding.blocks, authoredNew: without, captured: await copyOf(without), compositionOf }), "no longer holds content that is protected here");
    // The inclusion is still offered, but its new copy lost the protected block.
    const emptied = [text("a", "A"), slot("wrap", await copyOf([text("other", "Other")]))];
    await conflicts(mergeInclusionCopy({ baseline: holding.source, current: holding.blocks, authoredOld: holding.blocks, authoredNew: emptied, captured: await copyOf(emptied), compositionOf }), "no longer holds content that is protected here");
    // Replacement by an unrelated source follows the same rule.
    const other = [text("z", "Z")];
    await conflicts(mergeInclusionCopy({ baseline: stored.source, current: stored.blocks, authoredNew: other, captured: await copyOf(other), compositionOf }), "no longer holds content that is protected here");
    // A new source that keeps it — changed, or no longer locked by its author — is adopted.
    const kept = [text("a", "A2"), text("b", "B2")];
    expect(bodies((await mergeInclusionCopy({ baseline: stored.source, current: stored.blocks, authoredOld: stored.blocks, authoredNew: kept, captured: await copyOf(kept), compositionOf })).blocks)).toEqual(["a:A2", "b:B2"]);
  });

  test("an inclusion changed here that the source dropped stays, with the protection its copy holds", async () => {
    const wrapper = slot("wrap", await copyOf([text("clause", "Clause", true), text("note", "Note")]));
    const stored = await copyOf([text("a", "A"), wrapper]);
    const inner = readInclusionCopy(wrapper.values.content);
    const mine = slot("wrap", { source: inner.source, blocks: [inner.blocks[0]!, text("note", "My note")] });
    const merged = await mergeInclusionCopy({ baseline: stored.source, current: [stored.blocks[0]!, mine], authoredOld: stored.blocks, authoredNew: [text("a", "A")], captured: await copyOf([text("a", "A")]), compositionOf });
    const kept = readInclusionCopy(merged.blocks[1]!.values.content);
    expect(kept.source.filter((entry) => entry.locked).map((entry) => entry.id)).toEqual(["clause"]);
    expect(holdsProtectedContent(merged, compositionOf)).toBe(true);
  });

  test("refuses a block both sides changed, a new lock on local work and an identity collision, leaving its inputs untouched", async () => {
    const stored = await copyOf([text("a", "A"), text("b", "B")]);
    const edited = [text("a", "A mine"), stored.blocks[1]!];
    const before = JSON.stringify([stored, edited]);
    await conflicts(mergeInclusionCopy({ baseline: stored.source, current: edited, authoredOld: stored.blocks, authoredNew: [text("a", "A theirs"), text("b", "B")], captured: await copyOf([text("a", "A theirs"), text("b", "B")]), compositionOf }), "also changed here");
    await conflicts(mergeInclusionCopy({ baseline: stored.source, current: edited, authoredOld: stored.blocks, authoredNew: stored.blocks, captured: await copyOf([text("a", "A", true), text("b", "B")]), compositionOf }), "locks a block that was changed here");
    await conflicts(mergeInclusionCopy({ baseline: stored.source, current: [stored.blocks[1]!], authoredOld: stored.blocks, authoredNew: stored.blocks, captured: await copyOf([text("a", "A", true), text("b", "B")]), compositionOf }), "protects a block that was removed here");
    await conflicts(mergeInclusionCopy({ baseline: stored.source, current: [...stored.blocks, text("n", "Mine")], authoredOld: stored.blocks, authoredNew: [...stored.blocks, text("n", "Theirs")], captured: await copyOf([...stored.blocks, text("n", "Theirs")]), compositionOf }), "identity of a block added here");
    expect(JSON.stringify([stored, edited])).toBe(before);
    // The same local text the source now also has is no conflict.
    const agreed = await mergeInclusionCopy({ baseline: stored.source, current: edited, authoredOld: stored.blocks, authoredNew: [text("a", "A mine"), text("b", "B")], captured: await copyOf([text("a", "A mine", true), text("b", "B")]), compositionOf });
    expect(agreed.blocks[0]).toEqual(text("a", "A mine", true));
  });

  test("merges a nested inclusion both sides changed from its own source record, keeping nested locks", async () => {
    const innerOld = [text("x", "X"), text("y", "Y", true)];
    const innerNew = [text("x", "X"), text("y", "Y2", true), text("z", "Z")];
    const stored = await copyOf([slot("s", await copyOf(innerOld))]);
    const mine = slot("s", { source: (await copyOf(innerOld)).source, blocks: [text("x", "X mine"), innerOld[1]!] });
    const merged = await mergeInclusionCopy({ baseline: stored.source, current: [mine], authoredOld: stored.blocks, authoredNew: [slot("s", await copyOf(innerNew))], captured: await copyOf([slot("s", await copyOf(innerNew))]), compositionOf });
    const nested = readInclusionCopy(merged.blocks[0]!.values.content);
    expect(bodies(nested.blocks)).toEqual(["x:X mine", "y:Y2", "z:Z"]);
    expect(nested.source.filter((entry) => entry.locked).map((entry) => entry.id)).toEqual(["y"]);
    expect(nested.blocks[1]!.locked).toBe(true);
    // A real conflict inside the nested inclusion refuses the whole update.
    const clash = [slot("s", await copyOf([text("x", "X theirs"), innerOld[1]!]))];
    await conflicts(mergeInclusionCopy({ baseline: stored.source, current: [mine], authoredOld: stored.blocks, authoredNew: clash, captured: await copyOf(clash), compositionOf }), "also changed here");
  });

  test("without the earlier source every local change is kept rather than weighed", async () => {
    const stored = await copyOf([text("a", "A"), text("b", "B")]);
    const merged = await mergeInclusionCopy({ baseline: stored.source, current: [text("a", "A mine"), stored.blocks[1]!], authoredNew: [text("a", "A theirs"), text("b", "B2")], captured: await copyOf([text("a", "A theirs"), text("b", "B2")]), compositionOf });
    expect(bodies(merged.blocks)).toEqual(["a:A mine", "b:B2"]);
  });
});
