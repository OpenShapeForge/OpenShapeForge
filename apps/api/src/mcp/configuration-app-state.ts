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
  const token = result._meta?.submissionToken;
  if (typeof token === "string") {
    pendingTokens.set(owner, { token, ...(typeof result._meta?.configurationId === "string" ? { id: result._meta.configurationId } : {}) });
    return result;
  }
  const held = pendingTokens.get(owner);
  if (!held) return result;
  const { token: heldToken, id } = held;
  const pending = await peekConfiguration(heldToken, db).catch(() => null);
  if (!pending || pending.tenantId !== owner.tenantId || pending.userId !== owner.userId) {
    pendingTokens.delete(owner);
    return result;
  }
  const metadata = configurationAppResult({}, heldToken, pending.displayName, pending.definitions, pending.messagePrefix, id, Boolean(pending.submissionCredential))._meta;
  return { ...result, _meta: { ...result._meta, ...metadata } };
}
