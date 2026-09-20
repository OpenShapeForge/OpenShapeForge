// SPDX-License-Identifier: BUSL-1.1
/**
 * What each role means to the person holding it, for the API.
 *
 * `whoami` and the opening sentence of an MCP session describe a person's
 * roles in words ("organization administrator", "may manage clients and other
 * relations"). Those words used to be a table inside the runtime, which meant
 * the base engine carried a host's vocabulary and a host's role rename showed
 * up as a stale phrase. They are authored on the role instead — `roleLabels`
 * in `authorization.yaml`, extended by a host's `authorizationPatch` — and
 * emitted here, keyed by role name, merged over every authored realm in
 * filename order (a later realm's entry for the same name wins).
 *
 * Shape: `{ [role]: { label?: { [lang]: string }, phrase?: { [lang]: string } } }`.
 * Display only: nothing decides a permission by a label.
 */
import type { AuthorizationConfigFile, AuthorizationRoleLabel } from "./types/authoring.js";

export const ROLE_LABELS_PATH = "apps/api/src/generated/compiler/role-labels.json";

export type RoleLabelTable = Record<string, AuthorizationRoleLabel>;

function sortedLanguages(text: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!text) return undefined;
  return Object.fromEntries(Object.entries(text).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

/**
 * English is what every reader falls back to (`whoami` speaks it, the
 * opening sentence resolves through it), so a label or phrase without it
 * would be a persona the runtime silently drops. Refused here, naming the
 * role, beside the schema's own `required: ["en"]`.
 */
function requireEnglish(role: string, kind: "label" | "phrase", text: Record<string, string> | undefined): void {
  if (text && !text.en?.trim()) {
    throw new Error(
      `roleLabels.${role}.${kind} has no English text; en is the fallback every reader resolves to.`,
    );
  }
}

export function buildRoleLabels(configs: readonly AuthorizationConfigFile[]): RoleLabelTable {
  const table: RoleLabelTable = {};
  for (const config of configs) {
    for (const [role, entry] of Object.entries(config.roleLabels ?? {})) {
      requireEnglish(role, "label", entry.label);
      requireEnglish(role, "phrase", entry.phrase);
      const label = sortedLanguages(entry.label);
      const phrase = sortedLanguages(entry.phrase);
      table[role] = { ...(label ? { label } : {}), ...(phrase ? { phrase } : {}) };
    }
  }
  return table;
}

export function renderRoleLabels(table: RoleLabelTable): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}
