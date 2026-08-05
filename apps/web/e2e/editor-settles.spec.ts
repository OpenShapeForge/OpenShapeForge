// SPDX-License-Identifier: BUSL-1.1
/**
 * The editor stops talking to the server.
 *
 * This is the detector for the defect in #275: an effect whose dependency was
 * an object literal rebuilt on every server render, calling a server action
 * that made Next revalidate the route, which produced a fresh literal, which
 * re-ran the effect — roughly seven calls a second, forever, with nobody
 * touching the page. See the `actionsRef` comment in
 * `apps/web/src/features/workflow/components/editor/use-definition-lock.ts`.
 *
 * The reason it is first is that it needed no foresight. A page that never
 * settles fails any assertion anyone would want to write about it, so this is
 * a precondition of the rest of the suite rather than a test somebody had to
 * think of. A simulated DOM cannot produce it at all: there is no router and
 * no revalidation there, so the closest a unit test gets is re-rendering with a
 * hand-made fresh object — a hypothesis about the mechanism rather than the
 * mechanism.
 */
import { expect, test } from "@playwright/test";
import { WEB_URL } from "./support/environment";
import { createDefinition, openEditor, watchAppTraffic } from "./support/workflow";

test("the editor settles after loading a definition", async ({ page }) => {
  const traffic = watchAppTraffic(page, WEB_URL);
  const definitionId = await createDefinition(page, `e2e settles ${Date.now()}`);

  await openEditor(page, definitionId);

  // The load itself makes calls — the lock is acquired on open, deliberately.
  // What is under test is what happens after that: it has to end.
  await traffic.settle({ quietMs: 2_000, timeoutMs: 20_000 });

  // Now watch a window with nothing happening in it. At the measured rate of
  // the original defect this would collect around thirty calls.
  traffic.reset();
  await page.waitForTimeout(4_000);

  expect(
    traffic.seen(),
    "the editor kept calling its own server with nobody touching the page",
  ).toEqual([]);

  // Still the editor, not an error boundary: an empty list would also be what a
  // crashed page produced.
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
});
