// SPDX-License-Identifier: BUSL-1.1
import type { ElkLayoutGraph } from "./elk.ts";
import type { WorkflowLayoutRuntime } from "./types.ts";

export type ElkEngine = { layout: (graph: ElkLayoutGraph) => Promise<ElkLayoutGraph> };
type ElkConstructor = new (options?: { workerUrl?: string }) => ElkEngine;

/**
 * The engine for either runtime. A browser bundle resolves `#elk-engine` to
 * `elk-engine.browser.ts` instead, so the server build of ELK and its worker
 * never reach a browser bundle through the `require` below.
 */
export async function loadElkEngine(runtime: WorkflowLayoutRuntime): Promise<ElkEngine> {
  const module: unknown = runtime === "server"
    ? require("elkjs/lib/main.js")
    : await import("elkjs/lib/elk.bundled.js");
  const Elk = ((module as { default?: unknown }).default ?? module) as ElkConstructor;
  return runtime === "server"
    ? new Elk({ workerUrl: resolveServerElkWorkerUrl() })
    : new Elk();
}

function resolveServerElkWorkerUrl() {
  const bun = (globalThis as {
    Bun?: {
      resolveSync?: (specifier: string, from: string) => string;
    };
  }).Bun;
  const resolved = bun?.resolveSync?.(
    "elkjs/lib/elk-worker.min.js",
    import.meta.dir,
  );
  if (!resolved) {
    throw new Error(
      "Server workflow layout requires Bun.resolveSync to locate the ELK worker.",
    );
  }
  return resolved;
}
