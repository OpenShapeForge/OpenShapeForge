// SPDX-License-Identifier: BUSL-1.1
import type { CSSProperties } from "react";

/**
 * Inline overrides for a subset of the design tokens in `../tokens/colors.css`.
 *
 * Applied as a `style` prop so a subtree renders in the Battery palette
 * regardless of the ambient theme. Because these are the same custom-property
 * names the stylesheet declares, an inline value simply wins for that subtree —
 * no class or cascade juggling needed.
 */
type ThemeInput = {
  /** Surface/foreground roles, e.g. `foregroundSubtle` -> `--color-foreground-subtle`. */
  modes: Record<string, string>;
  /** Brand ramps, e.g. `indigo100` -> `--color-brand-indigo-100`. */
  brand: Record<string, string>;
};

const camelToKebab = (value: string) =>
  value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** `indigo100` -> `brand-indigo-100`; a ramp name is a word plus a numeric step. */
const brandToKebab = (value: string) => {
  const match = /^([a-zA-Z]+?)(\d+)$/.exec(value);
  return match ? `brand-${match[1]!.toLowerCase()}-${match[2]}` : `brand-${camelToKebab(value)}`;
};

function createTheme({ modes, brand }: ThemeInput): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(modes).map(([key, value]) => [`--color-${camelToKebab(key)}`, value]),
    ),
    ...Object.fromEntries(
      Object.entries(brand).map(([key, value]) => [`--color-${brandToKebab(key)}`, value]),
    ),
  };
}

const batteryTheme = createTheme({
  modes: {
    background: "#f3f3f4",
    surface: "#f7f7f8",
    card: "#ffffff",
    input: "#ffffff",
    accent: "#e5e5e6",
    foreground: "#0f1218",
    foregroundSubtle: "#3a4254",
    foregroundMuted: "#6b7486",
    borderMuted: "#f2f4f7",
    borderSubtle: "#e5e7eb",
  },
  brand: {
    indigo100: "#5d71c7",
    indigo80: "#7e8ed3",
    indigo40: "#dee2f4",
    indigo20: "#edf0f9",
    smartblue100: "#5a7fc0",
    smartblue80: "#7a99ce",
    smartblue10: "#e7eef7",
  },
});

export function batteryThemeStyle(style?: CSSProperties): CSSProperties {
  return {
    ...batteryTheme,
    ...style,
  } as CSSProperties;
}
