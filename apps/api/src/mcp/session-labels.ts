// SPDX-License-Identifier: BUSL-1.1
/**
 * The words a session's facts are shown in: role labels, what a permission
 * role lets a person do, which OAuth client a name stands for, and the small
 * duration helpers `whoami` and the opening sentence share.
 *
 * Split out of `session-info.ts` so the opening sentence a session starts
 * with (`session-opening.ts`) and the `whoami` answer describe a role with
 * the same words. Every label here is a display value; nothing decides a
 * permission by it — `TrustedSessionContext.roles` remains the authority.
 *
 * Languages: English is what `whoami` speaks (the assistant translates for
 * the person); the opening sentence is written in the person's own language,
 * so the phrases carry `nl` beside `en`. Anything else falls back to English.
 */
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { productName } from "../config/product-name.js";

/** The languages a phrase is authored in. */
export type PhraseLanguage = "en" | "nl";

/** Personas the membership row records (auth/employee-invitations.ts) or the
 * realm's composites name; the label is what a person reads. */
export const ROLE_LABELS: ReadonlyArray<{
  role: string;
  label: string;
  /** Lower-case, for inside a sentence: "organization administrator of X". */
  phrase: Record<PhraseLanguage, string>;
}> = [
  {
    role: "org_admin",
    label: "Organization administrator",
    phrase: { en: "organization administrator", nl: "organisatiebeheerder" },
  },
  {
    role: "org_employee",
    label: "Employee",
    phrase: { en: "employee", nl: "medewerker" },
  },
  {
    role: "pentester",
    label: "Pentester",
    phrase: { en: "pentester", nl: "pentester" },
  },
];

/** Keycloak's own bookkeeping roles: present on every token, meaningless here. */
export const KEYCLOAK_BUILTIN_ROLE =
  /^(default-roles-.+|offline_access|uma_authorization|manage-account|manage-account-links|manage-consent|view-profile|view-groups|view-applications|view-consent|delete-account)$/;

/**
 * What a permission role lets a person do, in plain words. Keyed by the
 * role name the realm issues; `<Area>.All.ReadWrite` implies `<Area>.All.Read`,
 * which `describePermissions` collapses so a sentence never says "manage
 * assessments and view assessments".
 */
const PERMISSION_PHRASES: Readonly<Record<string, Record<PhraseLanguage, string>>> = {
  "Pentest.All.ReadWrite": {
    en: "manage assessments and findings",
    nl: "assessments en bevindingen beheren",
  },
  "Pentest.All.Read": {
    en: "view assessments and findings",
    nl: "assessments en bevindingen inzien",
  },
  "Relations.All.ReadWrite": {
    en: "manage clients and other relations",
    nl: "klanten en andere relaties beheren",
  },
  "Relations.All.Read": {
    en: "view clients and other relations",
    nl: "klanten en andere relaties inzien",
  },
  "CaseFile.All.ReadWrite": { en: "manage case files", nl: "dossiers beheren" },
  "CaseFile.All.Read": { en: "view case files", nl: "dossiers inzien" },
  "Organization.All.ReadWrite": {
    en: "manage the organization's settings",
    nl: "de organisatie-instellingen beheren",
  },
  "CpqCatalog.All.ReadWrite": {
    en: "manage quotes and the catalog",
    nl: "offertes en de catalogus beheren",
  },
  "CpqCatalog.All.Read": { en: "view quotes and the catalog", nl: "offertes en de catalogus inzien" },
  "General.All.Read": { en: "view general records", nl: "algemene gegevens inzien" },
  integration_admin: { en: "manage integrations", nl: "koppelingen beheren" },
  integration_user: { en: "use integrations", nl: "koppelingen gebruiken" },
};

const PERMISSION_PATTERN = /^([A-Za-z]+)\.All\.(ReadWrite|Read)$/;

/**
 * Split effective roles into the composite (the first `ROLE_LABELS` entry
 * present) and the permission roles, with Keycloak's noise removed. The
 * permissions are sorted so an answer is stable across tokens.
 */
export function classifyRoles(roles: readonly string[]): {
  composite: (typeof ROLE_LABELS)[number] | null;
  permissions: string[];
} {
  const unique = [...new Set(roles)];
  const composite = ROLE_LABELS.find((entry) => unique.includes(entry.role)) ?? null;
  const permissions = unique
    .filter(
      (role) =>
        !ROLE_LABELS.some((entry) => entry.role === role) &&
        !KEYCLOAK_BUILTIN_ROLE.test(role),
    )
    .sort((left, right) => left.localeCompare(right));
  return { composite, permissions };
}

/**
 * The permission roles as plain-word phrases, in `language`. A role without
 * an authored phrase but in the `<Area>.All.<Read|ReadWrite>` shape gets a
 * generic one from its area; anything else is left out rather than shown
 * as a technical name. Read-only roles shadowed by a ReadWrite on the same
 * area are dropped.
 */
export function describePermissions(
  permissions: readonly string[],
  language: PhraseLanguage,
): string[] {
  const areasWithWrite = new Set(
    permissions
      .map((role) => PERMISSION_PATTERN.exec(role))
      .filter((match): match is RegExpExecArray => match !== null && match[2] === "ReadWrite")
      .map((match) => match[1]),
  );
  const phrases: string[] = [];
  for (const role of permissions) {
    const match = PERMISSION_PATTERN.exec(role);
    if (match && match[2] === "Read" && areasWithWrite.has(match[1]!)) continue;
    const authored = PERMISSION_PHRASES[role]?.[language];
    if (authored) {
      phrases.push(authored);
    } else if (match) {
      const area = match[1]!.toLowerCase();
      phrases.push(
        language === "nl"
          ? `${area} ${match[2] === "ReadWrite" ? "beheren" : "inzien"}`
          : `${match[2] === "ReadWrite" ? "manage" : "view"} ${area}`,
      );
    }
  }
  return [...new Set(phrases)];
}

/** "a, b and c" / "a, b en c". */
export function joinPhrases(phrases: readonly string[], language: PhraseLanguage): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  const conjunction = language === "nl" ? "en" : "and";
  return `${phrases.slice(0, -1).join(", ")} ${conjunction} ${phrases[phrases.length - 1]}`;
}

/**
 * Friendly names for the OAuth clients a token can be issued to (`azp`). The
 * product's own gateways carry the deployment's product name
 * (OPENSHAPEFORGE_PRODUCT_NAME), read per call.
 */
export function clientNames(): Readonly<Record<string, string>> {
  const product = productName();
  return {
    codex: "Codex",
    "openshapeforge-inspector": "MCP Inspector",
    "openshapeforge-gateway": product,
    // The control realm's clients (platform administrator MCP, control/platform-tools.ts).
    "codex-platform": "Codex",
    "openshapeforge-admin-gateway": `${product} control plane`,
  };
}

/**
 * Only the two fields it actually reads, so a caller that has a credential but
 * not a whole `SessionIdentity` — the platform control plane builds one from
 * its own administrator record — does not have to invent the rest.
 */
export function signedInViaLabel(identity: {
  credential: TrustedSessionContext["credential"];
  authorizedParty: string | null;
}): string {
  switch (identity.credential) {
    case "trusted-context":
      return "Development identity";
    case "api-key":
      return "API key";
    case "bearer":
      return identity.authorizedParty
        ? (clientNames()[identity.authorizedParty] ?? identity.authorizedParty)
        : "Unknown client";
    default:
      return "Unknown";
  }
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "12 minutes", "1 hour 5 minutes", "2 days 3 hours", "45 seconds". */
export function humanizeDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(Math.abs(ms) / 1000));
  if (totalSeconds < 60) return plural(totalSeconds, "second");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return plural(totalMinutes, "minute");
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return plural(totalHours, "hour") + (minutes > 0 ? ` ${plural(minutes, "minute")}` : "");
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return plural(days, "day") + (hours > 0 ? ` ${plural(hours, "hour")}` : "");
}

/** "in 12 minutes", or "12 minutes ago" once the moment has passed. */
export function describeExpiry(expiresAtMs: number, nowMs: number): string {
  const remaining = expiresAtMs - nowMs;
  return remaining >= 0
    ? `in ${humanizeDuration(remaining)}`
    : `${humanizeDuration(-remaining)} ago`;
}
