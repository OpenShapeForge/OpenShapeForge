// SPDX-License-Identifier: BUSL-1.1
/**
 * The MCP App of the configuration handoff: the bundled client script and
 * the page that carries it, plus the plain message page. Split out of
 * configuration-handoff.ts, verbatim.
 */

import { fileURLToPath } from "node:url";
import { renderNoticePage } from "./browser-pages.js";

let configurationAppScript: Promise<string> | undefined;
export const PAGE_STYLE =
  "font-family:system-ui;margin:3rem auto;max-width:30rem;padding:0 1rem;line-height:1.5";

/**
 * A branded single-sentence page. Call sites that know the outcome should
 * use the dedicated pages in browser-pages.ts (saved / expired / failed).
 */
export function renderMessagePage(message: string): string {
  return renderNoticePage(message);
}

export async function bundledConfigurationApp(): Promise<string> {
  configurationAppScript ??= (async () => {
    const result = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL("./configuration-app-client.ts", import.meta.url),
        ),
      ],
      target: "browser",
      minify: true,
      sourcemap: "none",
    });
    if (!result.success || !result.outputs[0]) {
      throw new Error(
        `MCP App bundle failed: ${result.logs.map(String).join("; ")}`,
      );
    }
    return result.outputs[0].text();
  })();
  return configurationAppScript;
}

/** Single-file MCP App; tool-result metadata supplies the private form URL. */
export async function renderConfigurationApp(): Promise<string> {
  const script = await bundledConfigurationApp();
  return (
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Secure configuration</title>` +
    `<body style="${PAGE_STYLE}"><h2 id="configuration-title" style="font-size:1.2rem">Secure configuration</h2>` +
    `<p id="configuration-message">Preparing the secure form…</p>` +
    `<button id="configuration-open" hidden type="button" ` +
    `style="padding:.6rem 1rem;border:1px solid #777;border-radius:6px;background:transparent">` +
    `Open in browser</button>` +
    `<iframe id="configuration-frame" hidden title="Secure configuration" ` +
    `style="width:100%;min-height:32rem;border:1px solid #ccc;border-radius:6px"></iframe>` +
    `<script type="module">${script}</script></body>`
  );
}
