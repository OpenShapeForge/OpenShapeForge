// SPDX-License-Identifier: BUSL-1.1
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { RuntimeModule } from "../modules/contract.js";
import type { ModulePlatformRuntime } from "../modules/platform.js";

const PNG_DATA_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_ICON_BYTES = 256 * 1024;

/** Never fetch a plugin-supplied location or let presentation widen authority. */
export function validatedServerIcons(input: readonly Icon[]): Icon[] {
  if (!Array.isArray(input) || input.length > 4) {
    throw new Error("MCP server icons must be a bounded icon list.");
  }
  return input.map((icon) => {
    if (!icon || typeof icon.src !== "string" || icon.src.length > MAX_ICON_BYTES ||
        !icon.src.startsWith(PNG_DATA_PREFIX) || icon.mimeType !== "image/png" ||
        icon.sizes?.length !== 1 || icon.sizes[0] !== "128x128" ||
        (icon.theme !== undefined && icon.theme !== "light" && icon.theme !== "dark")) {
      throw new Error("MCP server icons must be bounded 128px PNG data URIs.");
    }
    const encoded = icon.src.slice(PNG_DATA_PREFIX.length);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length < 33 || bytes.toString("base64") !== encoded ||
        !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
        bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(8) !== 13 ||
        bytes.readUInt32BE(16) !== 128 || bytes.readUInt32BE(20) !== 128) {
      throw new Error("MCP server icon bytes do not match their PNG representation.");
    }
    return { src: icon.src, mimeType: "image/png", sizes: ["128x128"],
      ...(icon.theme ? { theme: icon.theme } : {}) };
  });
}

export async function resolveServerIcons(
  modules: readonly RuntimeModule[] | undefined,
  modulePlatform: ModulePlatformRuntime | undefined,
  verifiedSession: TrustedSessionContext,
): Promise<Icon[] | undefined> {
  const owners = (modules ?? []).filter((module) => module.mcp?.serverIcons);
  if (owners.length === 0) return undefined;
  if (!modulePlatform) throw new Error("MCP server icon projection requires an active platform capability.");
  return modulePlatform.withActiveOperationSession(verifiedSession, async (session) => {
    let icons: Icon[] | undefined;
    for (const module of owners) {
      const projected = await module.mcp!.serverIcons!({ session, platform: modulePlatform.services });
      if (projected === undefined) continue;
      if (icons !== undefined) throw new Error("Multiple modules own MCP server icons.");
      icons = validatedServerIcons(projected);
    }
    return icons;
  });
}
