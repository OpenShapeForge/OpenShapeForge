// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  getCssColor,
  getCssFontWeight,
  getCssNumber,
} from "../edge-route-css.js";

describe("getCssColor", () => {
  test("keeps a real colour", () => {
    expect(getCssColor("var(--color-foreground)", "#000")).toBe(
      "var(--color-foreground)",
    );
  });

  test("falls back for undefined, blank, and numeric values", () => {
    expect(getCssColor(undefined, "#000")).toBe("#000");
    expect(getCssColor("   ", "#000")).toBe("#000");
    expect(getCssColor(2, "#000")).toBe("#000");
  });
});

describe("getCssNumber", () => {
  test("keeps a finite number", () => {
    expect(getCssNumber(2, 1)).toBe(2);
    expect(getCssNumber(0, 1)).toBe(0);
  });

  test("parses a numeric prefix out of a CSS length", () => {
    expect(getCssNumber("2.5px", 1)).toBe(2.5);
    expect(getCssNumber("-3", 1)).toBe(-3);
  });

  test("falls back for undefined, non-finite, and unparseable values", () => {
    expect(getCssNumber(undefined, 1)).toBe(1);
    expect(getCssNumber(Number.NaN, 1)).toBe(1);
    expect(getCssNumber(Number.POSITIVE_INFINITY, 1)).toBe(1);
    expect(getCssNumber("thick", 1)).toBe(1);
  });
});

describe("getCssFontWeight", () => {
  test("passes both spellings of a weight through", () => {
    expect(getCssFontWeight(600)).toBe(600);
    expect(getCssFontWeight("semibold")).toBe("semibold");
  });

  test("drops undefined", () => {
    expect(getCssFontWeight(undefined)).toBeUndefined();
  });
});
