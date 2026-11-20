// SPDX-License-Identifier: BUSL-1.1
import type { ElkEngine } from "./elk-engine.ts";

type ElkConstructor = new () => ElkEngine;

/** Browser bundles carry one ELK: the self-contained build, loaded on first layout. */
export async function loadElkEngine(_runtime?: unknown): Promise<ElkEngine> {
  const module: unknown = await import("elkjs/lib/elk.bundled.js");
  return new (((module as { default?: unknown }).default ?? module) as ElkConstructor)();
}
