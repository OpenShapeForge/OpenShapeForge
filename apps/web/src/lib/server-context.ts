// SPDX-License-Identifier: BUSL-1.1
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { getCachedSession } from "@/lib/cached-session";
import { isKnownPublicPath } from "@/lib/public-routes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid sector contexts in the platform. */
export type SectorContext = "core" | "vera";

/** Valid UI languages. */
export type Lang = "en" | "nl";

/** A translatable label keyed by language. */
export type TranslatableLabel = Record<string, string>;

// ---------------------------------------------------------------------------
// Sector <-> language mapping
//
// Each sector has a primary language. This mapping is the single source of
// truth and will grow as new sectors are added.
// ---------------------------------------------------------------------------

const SECTOR_LANG: Record<SectorContext, Lang> = {
  core: "en",
  vera: "nl",
};

const VALID_SECTORS = new Set<string>(Object.keys(SECTOR_LANG));

const DEFAULT_CONTEXT: SectorContext = "core";
const DEFAULT_LANG: Lang = "en";

// Cookie name used to persist the user's active context override.
// This allows the UI to switch context without requiring a full re-auth.
const CONTEXT_COOKIE = "openshapeforge.context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidSector(value: unknown): value is SectorContext {
  return typeof value === "string" && VALID_SECTORS.has(value);
}

function isValidLang(value: unknown): value is Lang {
  return value === "en" || value === "nl";
}

const LANGUAGE_COOKIE = "openshapeforge.lang";

const resolveServerContext = cache(async (): Promise<{
  context: SectorContext;
  lang: Lang;
}> => {
  let overrideContext: SectorContext | undefined;
  let overrideLang: Lang | undefined;

  try {
    const cookieStore = await cookies();
    const contextCookie = cookieStore.get(CONTEXT_COOKIE)?.value;
    const langCookie = cookieStore.get(LANGUAGE_COOKIE)?.value;

    if (isValidSector(contextCookie)) {
      overrideContext = contextCookie;
    }
    if (isValidLang(langCookie)) {
      overrideLang = langCookie;
    }
  } catch {
    // cookies() throws outside a request context (e.g. during build).
  }

  let context = overrideContext ?? DEFAULT_CONTEXT;

  let pathname: string | null = null;
  try {
    pathname = (await headers()).get("x-app-pathname");
  } catch {
    // headers() throws outside a request context (e.g. during build).
  }

  if (!overrideContext && !isKnownPublicPath(pathname)) {
    try {
      const session = await getCachedSession();
      if (session?.actorType && isValidSector(session.actorType)) {
        context = session.actorType;
      }
    } catch {
      // Auth may fail if Redis is unavailable or no session exists.
      // Fall back to the default context.
    }
  }

  return {
    context,
    lang: overrideLang ?? SECTOR_LANG[context] ?? DEFAULT_LANG,
  };
});

// ---------------------------------------------------------------------------
// getActiveContext
// ---------------------------------------------------------------------------

/**
 * Determines the active sector context for the current request.
 *
 * Resolution order:
 * 1. Context-override cookie (`openshapeforge.context`) - set by the UI context switcher
 * 2. Session `actorType` from Keycloak - the tenant's default sector
 * 3. Default fallback (`"core"`)
 */
export async function getActiveContext(): Promise<SectorContext> {
  const { context } = await resolveServerContext();
  return context;
}

// ---------------------------------------------------------------------------
// getActiveLang
// ---------------------------------------------------------------------------

/**
 * Determines the active UI language for the current request.
 *
 * The language is derived from the active sector context, ensuring that
 * sector-specific pages always render in their primary language.
 *
 * Resolution order:
 * 1. Language override cookie (`openshapeforge.lang`) - for future per-user language prefs
 * 2. Derived from the active sector context
 * 3. Default fallback (`"en"`)
 */
export async function getActiveLang(): Promise<Lang> {
  const { lang } = await resolveServerContext();
  return lang;
}

// ---------------------------------------------------------------------------
// t – translation helper
// ---------------------------------------------------------------------------

/**
 * Resolves a translatable label to the string for the given language.
 *
 * Falls back gracefully:
 * - If the requested language key is missing, returns the English value.
 * - If English is also missing, returns the first available value.
 * - If the label is empty or not an object, returns an empty string.
 *
 * @example
 *   t({ en: "Hello", nl: "Hallo" }, "nl")  // => "Hallo"
 *   t({ en: "Hello", nl: "Hallo" }, "en")  // => "Hello"
 *   t({ en: "Hello" }, "nl")               // => "Hello" (fallback)
 */
export function t(label: TranslatableLabel | undefined | null, lang: string): string {
  if (!label || typeof label !== "object") return "";

  // Exact match
  if (typeof label[lang] === "string") return label[lang];

  // Fallback to English
  if (typeof label.en === "string") return label.en;

  // Fallback to first available value
  const values = Object.values(label);
  for (const v of values) {
    if (typeof v === "string") return v;
  }

  return "";
}
