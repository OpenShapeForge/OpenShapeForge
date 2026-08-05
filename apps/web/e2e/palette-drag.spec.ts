// SPDX-License-Identifier: BUSL-1.1
/**
 * A palette drag reaches the canvas, and the canvas knows about it while it is
 * still in flight.
 *
 * This is the detector for the second defect in #275: `onCanvasDragOver` never
 * firing, because the handler behind it read `dataTransfer.getData()` during
 * `dragover`. Real Chromium keeps the drag data store protected until the drop
 * and answers that read with `""`, so the handler bailed on every move.
 *
 * ## The mid-drag assertion is the one that matters
 *
 * The drop is not enough on its own, and this is worth spelling out because it
 * is the difference between a test and a decoration. In the broken handler
 * `preventDefault()` ran BEFORE the bail, so the drop stayed allowed and the
 * node still landed: "drag an item onto the surface and assert a node appears"
 * passes against the bug. What the bug actually destroyed is everything the
 * canvas does DURING the drag — the preview card, and with it the edge-insert
 * target the preview is positioned against.
 *
 * So the drag is held open here. The preview is a node in the same array the
 * real ones come from, so it appears as one more `.react-flow__node`, and its
 * presence mid-drag is precisely "`onCanvasDragOver` fired". Reverting the fix
 * in `FlowCanvas.tsx` and running this spec fails on that assertion.
 *
 * A simulated DOM cannot make this judgement: happy-dom returns the payload
 * from a protected store and jsdom has no `DataTransfer` at all, so both agree
 * with the broken handler.
 */
import { expect, test } from "@playwright/test";
import {
  CANVAS_NODE,
  canvasPane,
  createDefinition,
  openEditor,
  paletteItems,
} from "./support/workflow";

test("dragging a palette node onto the canvas previews it and then places it", async ({
  page,
}) => {
  const definitionId = await createDefinition(page, `e2e drag ${Date.now()}`);
  await openEditor(page, definitionId);

  // A new definition draws nothing, so every node counted below arrived from
  // this drag.
  await expect(page.locator(CANVAS_NODE)).toHaveCount(0);

  const item = paletteItems(page).first();
  await expect(item).toBeVisible();
  const label = await item.locator('[role="button"]').getAttribute("aria-label");
  expect(label, "the palette offered no node type to drag").toBeTruthy();

  const pane = await canvasPane(page).boundingBox();
  if (!pane) throw new Error("the canvas has no box to drop onto");
  const target = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };

  // Driven by hand rather than with `dragTo` so the drag can be inspected while
  // it is still open. The press has to become a drag before any move counts as
  // a `dragover`, hence the short move over the palette row first.
  await item.hover();
  await page.mouse.down();
  await page.mouse.move(target.x, target.y - 40, { steps: 8 });
  await page.mouse.move(target.x, target.y, { steps: 8 });

  // A real browser repeats `dragover` while the cursor sits over a target;
  // a synthetic one only sends what is dispatched. So the cursor is nudged
  // until the preview shows up — which does not soften the assertion, because a
  // handler that never fires produces nothing however far the cursor travels.
  const canvasNodes = page.locator(CANVAS_NODE);
  for (let nudge = 0; nudge < 8 && (await canvasNodes.count()) === 0; nudge += 1) {
    await page.mouse.move(target.x + (nudge % 2 === 0 ? 6 : -6), target.y + nudge, {
      steps: 2,
    });
  }

  await expect(
    canvasNodes,
    "no preview appeared while the drag was over the canvas, so onCanvasDragOver never fired",
  ).toHaveCount(1);

  // The preview is drawn UNDER the cursor of the drag that created it, so it
  // must not be something the pointer can move onto. Without this the browser
  // treats it as the new drop target, fires `dragleave` on the canvas and then
  // `dragleave` on the preview with no target left, and refuses the drop:
  // `dragend` arrives instead of `drop`, the preview vanishes, and nothing is
  // placed.
  //
  // Asserted here rather than left to the drop below, because the drop only
  // fails when the preview happens to render between the last move and the
  // release. That made this spec fail about one CI run in nine and pass every
  // time locally. This assertion fails every time instead.
  await expect(
    canvasNodes.first(),
    "the drag preview accepts pointer events, so it steals the drop target from the canvas",
  ).toHaveCSS("pointer-events", "none");

  await page.mouse.up();

  // The preview is replaced by the node it stood for: still one card, now the
  // real one, and the header says the graph changed.
  await expect(page.locator(CANVAS_NODE)).toHaveCount(1);
  await expect(page.locator(CANVAS_NODE).first()).toContainText(label!);
  await expect(page.getByText("unsaved changes")).toBeVisible();
});
