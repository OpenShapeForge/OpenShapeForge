// SPDX-License-Identifier: BUSL-1.1
/**
 * Language tags as the runtime and its plugins read them. One definition, so a
 * plugin choosing the language of a notification and the API choosing the
 * language of a session agree on what `nl-NL`, `nl_NL` and `NL` mean.
 */

/**
 * The base language of a tag: `nl-NL` and `nl` are the same language, and an
 * authored text is keyed by language, never by region. Returns null for
 * anything that is not a usable tag, so a malformed value falls through to the
 * next step of whatever order the caller walks instead of becoming a language
 * nobody speaks.
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
