// SPDX-License-Identifier: BUSL-1.1
/**
 * The language the signed-in person reads, and the one resolver that turns an
 * authored `{ en, nl, … }` text into it.
 *
 * The identity provider is the source, and the only one. A person's language
 * belongs to the person, not to the organization they act for: the same
 * employee working for two clients should not set it twice, and a second
 * setting inside this server would be a second thing to keep in step. So the
 * runtime reads the `locale` claim the realm already puts in a verified token
 * (Keycloak's built-in `profile` mapper, once the realm has
 * `internationalizationEnabled`) and never stores its own.
 *
 * What this is NOT: it is a display fact, in the same class as the name and
 * e-mail `session-info.ts` reads from the same token. Nothing may depend on it
 * for a decision — no row is visible in Dutch and hidden in English, no tool is
 * admitted by language. It decides which of several authored strings a person
 * is shown, and which language an assistant is told to answer in.
 *
 * The fallback order is written out rather than assumed, because a silent
 * assumption here is invisible: it produces a plausible answer in the wrong
 * language.
 *
 *   1. the person's own language, from the token's `locale` claim;
 *   2. the realm's default, which deployments state in
 *      `OPENSHAPEFORGE_DEFAULT_LOCALE` — the realm's own `defaultLocale` lives
 *      in the identity provider's admin API and is not cheaply readable from
 *      here, the same reason `OPENSHAPEFORGE_SESSION_IDLE_DAYS` exists;
 *   3. the host's default, from the process locale (`Intl`).
 *
 * Step 3 always produces something, so `resolveLocale` is total: there is no
 * "unknown language" state for a caller to handle.
 */

/** The token claim Keycloak's `profile` client scope carries the language in. */
export const LOCALE_CLAIM = "locale";

/**
 * The realm's default language, stated by the deployment. See the fallback
 * order above for why this is not read from the identity provider directly.
 */
export const DEFAULT_LOCALE_ENV = "OPENSHAPEFORGE_DEFAULT_LOCALE";

/** Which step of the fallback order an answer came from. */
export type LocaleSource = "user" | "realm" | "host";

export type ResolvedLocale = {
  /** Base language subtag, e.g. `nl` — a region (`nl-BE`) narrows nothing here. */
  tag: string;
  /** The language's own name for itself, e.g. "Nederlands". */
  name: string;
  /** The language's English name, e.g. "Dutch", for text addressed to a model. */
  englishName: string;
  /** The step of the fallback order this came from. */
  source: LocaleSource;
};

/**
 * The base language of a tag: `nl-NL` and `nl` are the same language, and an
 * authored text is keyed by language, never by region. Returns null for
 * anything that is not a usable tag, so a malformed claim falls through to the
 * next step of the order instead of becoming a language nobody speaks.
 */
export function baseLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const language = new Intl.Locale(trimmed.replace(/_/g, "-")).language;
    return language && language !== "und" ? language.toLowerCase() : null;
  } catch {
    return null;
  }
}

function languageName(tag: string, inLocale: string): string {
  try {
    const names = new Intl.DisplayNames([inLocale], { type: "language" });
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The process's own language — the last step, and the one that always answers. */
export function hostLanguage(): string {
  return baseLanguage(new Intl.DateTimeFormat().resolvedOptions().locale) ?? "en";
}

export function defaultLocaleFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return baseLanguage(env[DEFAULT_LOCALE_ENV]);
}

/**
 * Walk the fallback order and say which step answered. `user` is the token's
 * `locale` claim; `realmDefault` defaults to the environment and `hostDefault`
 * to the process locale, both overridable so the order can be unit-tested
 * without touching either.
 */
export function resolveLocale(
  input: {
    user?: unknown;
    realmDefault?: unknown;
    hostDefault?: unknown;
  } = {},
): ResolvedLocale {
  const steps: Array<{ source: LocaleSource; value: string | null }> = [
    { source: "user", value: baseLanguage(input.user) },
    {
      source: "realm",
      value:
        input.realmDefault === undefined
          ? defaultLocaleFromEnv()
          : baseLanguage(input.realmDefault),
    },
    {
      source: "host",
      value:
        input.hostDefault === undefined
          ? hostLanguage()
          : (baseLanguage(input.hostDefault) ?? hostLanguage()),
    },
  ];
  const chosen = steps.find((step) => step.value !== null)!;
  const tag = chosen.value!;
  return {
    tag,
    name: languageName(tag, tag),
    englishName: languageName(tag, "en"),
    source: chosen.source,
  };
}

/**
 * One authored text, in the language this session reads.
 *
 * Accepts what the authoring layer actually produces: a plain string (already
 * one language) or a `{ en, nl, … }` map. Resolution order inside the map is
 * the session's language, then English, then whichever translation exists —
 * an authored text that exists in only one language is still better than the
 * key, and better than an assistant translating it back and forth.
 *
 * This replaces the English-first `localized()` helpers that were copied
 * across this transport; they hard-coded `en ?? nl ?? fr`, which is the right
 * answer only for an English reader.
 */
export function localizedText(
  value: unknown,
  locale: ResolvedLocale | string | undefined,
): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tag = typeof locale === "string" ? baseLanguage(locale) : (locale?.tag ?? null);
  const candidates = [
    ...(tag ? [record[tag]] : []),
    record.en,
    ...Object.values(record),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}
