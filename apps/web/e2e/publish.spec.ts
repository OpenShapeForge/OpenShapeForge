// SPDX-License-Identifier: BUSL-1.1
/**
 * Publishing is refused while the graph is unfinished, and reported by the list
 * once it is not.
 *
 * #240 §6 names S7's gate as "a designer e2e: create, edit, save, publish, run".
 * The smoke spec covers create, edit and save; this covers publish. Run has no
 * screen yet — S5's instance console is not in the tree — so the journey stops
 * here until it is.
 *
 * ## Why the refusal is the half worth writing first
 *
 * #262 names this exact case as the thing no other gate reaches: "clicking
 * Publish on an unpublishable graph does nothing". The decision behind it is
 * already tested — `summarizeWorkflowValidation` lives in
 * `examples/plugins/workflow/web/editor/validation-view.ts` and `bun test
 * examples` reaches it. What no unit test reaches is whether the button is
 * wired to that answer, whether the answer is refreshed by a save, and whether
 * the panel beside it says which node is at fault. That is assembly, and it is
 * three components and a server round trip apart.
 *
 * A `decision` is the cheapest graph a designer can draw that is well-formed
 * and not runnable: it declares a `default` output handle from an empty branch
 * list, nothing wires it, and `ORPHAN_NODE_HANDLE` blocks at publish rather
 * than at write — which is what makes the save below succeed and the publish
 * not. See `declaredOutputHandles` in
 * `examples/plugins/workflow/runtime/definition-validation.ts`.
 */
import { expect, test, type Page } from "@playwright/test";
import { CANVAS_NODE, createDefinition, openEditor, paletteItems } from "./support/workflow";

/** The header button, which the editor disables from the validation summary. */
const publishButton = (page: Page) =>
  page.getByRole("button", { name: "Publish", exact: true });

test("an unfinished graph refuses a publish, and the panel names what is missing", async ({
  page,
}) => {
  const definitionId = await createDefinition(page, `e2e unpublishable ${Date.now()}`);
  await openEditor(page, definitionId);

  // By accessible name rather than by position: this spec needs one specific
  // node type, and the label is authored in this repo
  // (`examples/plugins/workflow/authoring/workflow-nodes/flow/decision.yaml`).
  const decision = paletteItems(page).filter({
    has: page.getByRole("button", { name: "Decision", exact: true }),
  });
  await expect(
    decision,
    "the palette no longer offers exactly one Decision node, so this spec is drawing a different graph than it describes",
  ).toHaveCount(1);
  await decision.locator('[role="button"]').click();
  await expect(page.locator(CANVAS_NODE)).toHaveCount(1);

  // The save has to succeed: a publish-blocking issue is what an unfinished
  // graph looks like, and refusing to store one would make the designer
  // unusable. Saving is also what refreshes the validation the button reads.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Saved as version \d+/)).toBeVisible();

  // The button alone would not be the assertion. `disabled` is four conditions
  // OR-ed together — read-only, busy, dirty, unpublishable — so a bare
  // `toBeDisabled()` here would pass while the save was still in flight and
  // prove nothing about the graph. The three below rule the other three out:
  // `openEditor` has already asserted the lock is held, the header drops
  // "unsaved changes" only once the save landed, and the Save button carries
  // "Saving…" for exactly as long as `busy` is set.
  await expect(page.getByRole("heading", { name: "Refuses a publish" })).toBeVisible();
  await expect(page.getByText("ORPHAN_NODE_HANDLE").first()).toBeVisible();
  await expect(page.getByText("unsaved changes")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();

  await expect(
    publishButton(page),
    "a graph with an unwired output handle offered a Publish that would be refused",
  ).toBeDisabled();
});

test("a published version is the one the list reports", async ({ page }) => {
  const name = `e2e publish ${Date.now()}`;
  const definitionId = await createDefinition(page, name);
  await openEditor(page, definitionId);

  // A trigger on its own is runnable, so this graph is the smallest publishable
  // one. Taken by position like the smoke spec, for the same reason: which type
  // it is does not matter here.
  const item = paletteItems(page).first();
  const label = await item.locator('[role="button"]').getAttribute("aria-label");
  expect(label, "the palette offered no node type to add").toBeTruthy();
  await item.locator('[role="button"]').click();
  await expect(page.locator(CANVAS_NODE)).toHaveCount(1);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Saved as version \d+/)).toBeVisible();

  await expect(publishButton(page)).toBeEnabled();
  await publishButton(page).click();
  await expect(page.getByText(/Published version \d+/)).toBeVisible();

  // The proof is the list rather than the editor's own header. The header
  // renders `record.publishedVersion`, and `handlePublish` sets a status
  // without adopting a refreshed record, so it still reads "never published"
  // on this screen until the route is loaded again. The list is a fresh read of
  // the definition, which is what makes it evidence that the version landed.
  await page.goto("/workflow");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
  await expect(row).toHaveCount(1);
  // By column rather than by text: "v1" is in the Draft cell too, and a match
  // there would be the version that was saved rather than the one published.
  await expect(row.getByRole("cell").nth(1)).toHaveText("v1");
  await expect(row.getByText("Published", { exact: true })).toBeVisible();
});
