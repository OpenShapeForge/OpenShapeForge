// SPDX-License-Identifier: BUSL-1.1
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { peekConfiguration } from "./configuration-handoff.js";
import { configurationAppResult } from "./handoff-results.js";

type Owner = { tenantId?: string | null; userId?: string | null };
// One server session owns its handoff. Weak keys release it when the session ends.
const pendingTokens = new WeakMap<Owner, { token: string; id?: string }>();

/** Rehydrated App cards need private metadata even when the latest result is a read. */
export async function retainConfigurationAppResult(
  result: CallToolResult,
  owner: Owner,
  db?: OpenShapeForgeDatabase,
): Promise<CallToolResult> {
  if (result.isError) return result;
  const url = result._meta?.configurationUrl;
  if (typeof url === "string") {
    try { pendingTokens.set(owner, { token: new URL(url).pathname.split("/").at(-1)!, ...(typeof result._meta?.configurationId === "string" ? { id: result._meta.configurationId } : {}) }); }
    catch { pendingTokens.delete(owner); }
    return result;
  }
  const held = pendingTokens.get(owner);
  if (!held) return result;
  const { token, id } = held;
  const pending = await peekConfiguration(token, db).catch(() => null);
  if (!pending || pending.tenantId !== owner.tenantId || pending.userId !== owner.userId) {
    pendingTokens.delete(owner);
    return result;
  }
  const metadata = configurationAppResult({}, token, pending.displayName, pending.definitions, pending.messagePrefix, id)._meta;
  return { ...result, _meta: { ...result._meta, ...metadata } };
}
