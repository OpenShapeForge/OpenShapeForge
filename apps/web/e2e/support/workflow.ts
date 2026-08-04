// SPDX-License-Identifier: BUSL-1.1
/**
 * The moves every workflow spec makes, and the traffic watcher one of them
 * needs.
 *
 * Selectors only. Nothing here decides anything about a workflow — that lives
 * in `examples/plugins/workflow/web/`, where `bun test examples` reaches it, and
 * a browser suite does not change where it belongs.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * React Flow's own class for a rendered node, which is the only handle on the
 * canvas that is not a CSS-module hash. Counting these is how a spec sees the
 * drag preview appear: the preview IS a node, added to the same array, and
 * removed again when the drop replaces it with the real one.
 */
export const CANVAS_NODE = ".react-flow__node";

/** A palette row: the draggable wrapper, not the card inside it. */
export function paletteItems(page: Page): Locator {
  return page.locator('aside li div[draggable="true"]');
}

/** The surface a drop lands on. */
export function canvasPane(page: Page): Locator {
  return page.locator(".react-flow__pane");
}

/**
 * Make a workflow from the list screen and end up in its editor.
 *
 * Every spec makes its own rather than sharing one. Opening a definition takes
 * an editing lock, and while the same user can always re-take their own lock,
 * two specs sharing a definition would also share its graph — so a failure in
 * one would arrive as a puzzle in the next.
 */
export async function createDefinition(page: Page, name: string): Promise<string> {
  await page.goto("/workflow");
  await expect(page.getByRole("heading", { name: "Workflows", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Workflow name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();

  // Creating navigates straight into the editor — "a definition with no graph
  // is not something to come back to from a list".
  await page.waitForURL(/\/workflow\/[0-9a-fA-F-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").pop();
  if (!id) throw new Error(`could not read a definition id out of ${page.url()}`);
  return id;
}

/**
 * Open a definition's editor and wait for it to be editable.
 *
 * "Editable" and not "loaded": the canvas mounts only once its box has real
 * dimensions, and the palette is disabled until the editing lock is held, so a
 * spec that started interacting before both would be racing the screen.
 */
export async function openEditor(page: Page, definitionId: string): Promise<void> {
  await page.goto(`/workflow/${definitionId}`);
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
  await expect(canvasPane(page)).toBeVisible();
  // The lock banner is the read-only state. Its absence is the assertion,
  // because a palette that cannot be dragged from would fail later and further
  // away from the reason.
  await expect(page.getByRole("button", { name: "Take over editing" })).toHaveCount(0);
}

export type AppTraffic = {
  /** Forget everything seen so far. */
  reset(): void;
  /** What has been seen since the last reset, newest last. */
  seen(): string[];
  /**
   * Resolve once nothing has been seen for `quietMs`, or throw describing what
   * kept arriving.
   */
  settle(options?: { quietMs?: number; timeoutMs?: number }): Promise<void>;
};

/**
 * Watch the calls this page makes back to its own server.
 *
 * ## A passive counter, not `page.route`
 *
 * Interception is the other way to do this, and it is the wrong one here. The
 * question is whether the page ever stops talking, and an interceptor answers
 * it from inside the request path: every request it sees, it must re-issue, so
 * a mistake in the handler changes the timing of the very thing being measured
 * — and a request it fulfils from the handler never reaches the server that
 * would have revalidated the route, which is the step that closed the loop.
 * `page.on("request")` observes and does nothing else.
 *
 * ## What counts
 *
 * Server actions are POSTs to the page's own URL, and an RSC navigation is a
 * GET carrying `_rsc`. Between them that is every call that can make Next
 * re-render this route, which is the cycle #275 describes. Static chunks are
 * not counted because a lazily loaded chunk is a page doing its job, and the
 * app-shell health poll is not counted because it is a 30-second GET that
 * belongs to the layout rather than to this screen — leaving it in would mean
 * choosing a quiet window shorter than a timer, which is a worse test.
 */
export function watchAppTraffic(page: Page, origin: string): AppTraffic {
  const seen: string[] = [];

  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin)) return;
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/api/health" || pathname.startsWith("/api/auth/")) return;
    const isServerAction = request.method() !== "GET";
    const isRscFetch = searchParams.has("_rsc");
    if (!isServerAction && !isRscFetch) return;
    seen.push(`${request.method()} ${pathname}${isRscFetch ? "?_rsc" : ""}`);
  });

  return {
    reset: () => seen.splice(0),
    seen: () => [...seen],
    async settle({ quietMs = 2_000, timeoutMs = 20_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const before = seen.length;
        await page.waitForTimeout(quietMs);
        if (seen.length === before) return;
        if (Date.now() >= deadline) {
          const rate = ((seen.length / timeoutMs) * 1000).toFixed(1);
          throw new Error(
            `the page never went quiet: ${seen.length} calls in ${timeoutMs}ms (~${rate}/s). ` +
              `Last few: ${seen.slice(-5).join(", ")}`,
          );
        }
      }
    },
  };
}
