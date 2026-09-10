// SPDX-License-Identifier: BUSL-1.1
/**
 * The language fallback order and the authored-text resolver (mcp/locale.ts).
 *
 * The order is the point of these tests: a wrong answer here is invisible —
 * it produces a fluent sentence in a language the reader does not use — so
 * each step is asserted for the language it yields AND for the step it says
 * it came from, which is what `whoami` shows a person.
 */
import { describe, expect, test } from "bun:test";
import {
  baseLanguage,
  localizedText,
  resolveLocale,
} from "../locale.js";

describe("baseLanguage", () => {
  test("keeps the language and drops the region", () => {
    expect(baseLanguage("nl")).toBe("nl");
    expect(baseLanguage("nl-NL")).toBe("nl");
    expect(baseLanguage("nl_BE")).toBe("nl");
    expect(baseLanguage("EN-GB")).toBe("en");
  });

  test("refuses what is not a language, so the next step of the order runs", () => {
    expect(baseLanguage(undefined)).toBeNull();
    expect(baseLanguage(null)).toBeNull();
    expect(baseLanguage("")).toBeNull();
    expect(baseLanguage("   ")).toBeNull();
    expect(baseLanguage("not a tag at all")).toBeNull();
    expect(baseLanguage(42)).toBeNull();
  });
});

describe("resolveLocale", () => {
  test("the person's own language wins, and says so", () => {
    expect(
      resolveLocale({ user: "nl-NL", realmDefault: "en", hostDefault: "fr" }),
    ).toMatchObject({ tag: "nl", source: "user", englishName: "Dutch" });
  });

  test("without one, the realm's default stands in", () => {
    expect(
      resolveLocale({ user: null, realmDefault: "nl", hostDefault: "fr" }),
    ).toMatchObject({ tag: "nl", source: "realm" });
  });

  test("without either, the host's default answers", () => {
    expect(
      resolveLocale({ user: null, realmDefault: null, hostDefault: "fr" }),
    ).toMatchObject({ tag: "fr", source: "host" });
  });

  test("a malformed claim falls through instead of becoming a language", () => {
    expect(
      resolveLocale({ user: "  ", realmDefault: "nl", hostDefault: "fr" }),
    ).toMatchObject({ tag: "nl", source: "realm" });
  });

  test("always answers: there is no unknown-language state", () => {
    const resolved = resolveLocale({ user: null, realmDefault: null });
    expect(resolved.tag).toMatch(/^[a-z]{2,3}$/);
    expect(resolved.source).toBe("host");
  });

  test("names the language both in itself and in English", () => {
    const nl = resolveLocale({ user: "nl" });
    expect(nl.name).toBe("Nederlands");
    expect(nl.englishName).toBe("Dutch");
  });
});

describe("localizedText", () => {
  const label = { en: "Test target", nl: "Testdoel" };

  test("gives the reader's own language", () => {
    expect(localizedText(label, resolveLocale({ user: "nl" }))).toBe("Testdoel");
    expect(localizedText(label, resolveLocale({ user: "en" }))).toBe("Test target");
  });

  test("accepts a plain tag as well as a resolved locale", () => {
    expect(localizedText(label, "nl-NL")).toBe("Testdoel");
  });

  test("falls back to English, then to whatever translation exists", () => {
    expect(localizedText(label, resolveLocale({ user: "fr" }))).toBe("Test target");
    expect(localizedText({ nl: "Alleen Nederlands" }, resolveLocale({ user: "fr" }))).toBe(
      "Alleen Nederlands",
    );
  });

  test("an empty translation does not win over a filled one", () => {
    expect(localizedText({ nl: "   ", en: "Test target" }, "nl")).toBe("Test target");
  });

  test("a text authored in one language passes straight through", () => {
    expect(localizedText("Testdoel", "en")).toBe("Testdoel");
  });

  test("nothing to say stays undefined rather than becoming a key", () => {
    expect(localizedText(undefined, "nl")).toBeUndefined();
    expect(localizedText({}, "nl")).toBeUndefined();
    expect(localizedText([], "nl")).toBeUndefined();
    expect(localizedText(7, "nl")).toBeUndefined();
  });
});
