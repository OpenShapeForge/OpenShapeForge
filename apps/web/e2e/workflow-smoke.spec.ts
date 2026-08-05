// SPDX-License-Identifier: BUSL-1.1
/**
 * List, open, and draw what was stored.
 *
 * The journey the other two specs assume works. It is last in value and first
 * in breadth: it crosses the definition list, the create dialog, the editor,
 * the palette, a save through a server action, and a fresh load that has to
 * rebuild the canvas out of the stored document rather than out of what the
 * browser still had in memory.
 *
 * The save is what makes the last step mean something. Asserting a canvas
 * renders a graph the same page just built proves nothing about storage; the
 * navigation back through the list is what makes the second render come from
 * the database.
 */
import { expect, test } from "@playwright/test";
import {
  CANVAS_NODE,
  createDefinition,
  openEditor,
  paletteItems,
} from "./support/workflow";

test("a saved graph comes back from the list", async ({ page }) => {
  const name = `e2e smoke ${Date.now()}`;
  const definitionId = await createDefinition(page, name);
  await openEditor(page, definitionId);

  // Clicking a palette entry adds the node without a drag — the same placement
  // path, minus the gesture the drag spec is about.
  const item = paletteItems(page).first();
  const label = await item.locator('[role="button"]').getAttribute("aria-label");
  expect(label, "the palette offered no node type to add").toBeTruthy();
  await item.locator('[role="button"]').click();
  await expect(page.locator(CANVAS_NODE)).toHaveCount(1);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Saved as version \d+/)).toBeVisible();

  // Back out to the list, and in again through the link a user would click.
  await page.goto("/workflow");
  const row = page.getByRole("link", { name });
  await expect(row).toBeVisible();
  await row.click();

  await page.waitForURL(`**/workflow/${definitionId}`);
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
  await expect(page.locator(CANVAS_NODE)).toHaveCount(1);
  await expect(page.locator(CANVAS_NODE).first()).toContainText(label!);
});
