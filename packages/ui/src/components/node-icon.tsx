// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Coloured 28×28 box that fronts a workflow node — used both inside the
 * library card and the canvas card, and inside the box-variant Radio when
 * picking a node type.
 *
 * @figma node-icon — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=22-5570
 *
 * Category mapping (code ↔ Figma `type`):
 *   - `trigger` ↔ `start-proces`
 *   - `default` ↔ `logic` / `communication` (share a palette in code)
 *   - `ai` ↔ `ai`
 *   - `case` ↔ `case`
 */
export type NodeCategory = "trigger" | "default" | "ai" | "case";

export type NodeIconType = "library" | "canvas";

export type CategoryStyle = {
  /** Library uses the lighter shade, canvas uses the darker shade. */
  iconBackground: { library: string; canvas: string };
  iconColor: string;
};

// IMPORTANT: these values are used in inline `style={{ backgroundColor }}` /
// `style={{ color }}` attributes, NOT via Tailwind utility classes — they
// must reference tokens that live on `:root`. The brand scales come from
// `@openshapeforge/ui/tokens` (imported into globals.css), so `--color-brand-*` is
// DOM-resolvable. Tailwind v4's `@theme inline` semantic tokens (e.g.
// `--color-foreground-subtle`) also resolve at runtime because `@theme inline`
// emits them to the cascade.
//
// Shade values mirror Figma's `node-icon` component (Battery: 22:5570) —
// library uses the lighter shade, canvas the darker shade.
export const CATEGORY_STYLES: Record<NodeCategory, CategoryStyle> = {
  trigger: {
    iconBackground: {
      library: "var(--color-brand-aquamarine-80)",
      canvas: "var(--color-brand-aquamarine-100)",
    },
    iconColor: "var(--color-white)",
  },
  default: {
    iconBackground: {
      library: "var(--color-brand-platinum-100)",
      canvas: "var(--color-brand-platinum-120)",
    },
    iconColor: "var(--color-white)",
  },
  ai: {
    iconBackground: {
      library: "var(--color-brand-amethyst-80)",
      canvas: "var(--color-brand-amethyst-100)",
    },
    iconColor: "var(--color-white)",
  },
  case: {
    iconBackground: {
      library: "var(--color-brand-indigo-100)",
      canvas: "var(--color-brand-indigo-100)",
    },
    iconColor: "var(--color-white)",
  },
};

export interface NodeIconProps {
  icon: ReactNode;
  category: NodeCategory;
  /**
   * Figma Battery `variant` — library (lighter palette) or canvas (darker).
   * Prefer this name; {@link type} is a legacy alias.
   */
  variant?: NodeIconType;
  /** @deprecated Use {@link variant}. */
  type?: NodeIconType;
  className?: string;
}

/**
 * @figma node-id=22-5571 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=22-5571
 * @figma node-id=199-4617 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=199-4617
 * @figma node-id=22-5574 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=22-5574
 * @figma node-id=22-5580 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=22-5580
 * @figma node-id=22-5583 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=22-5583
 * @figma node-id=22-5586 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=22-5586
 * @figma node-id=22-5589 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=22-5589
 * @figma node-id=22-5592 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=22-5592
 * @figma node-id=87-2333 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=87-2333
 * @figma node-id=87-2330 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=87-2330
 */
export function NodeIcon({
  icon,
  category,
  variant,
  type,
  className,
}: NodeIconProps) {
  // Defensive fallback: if a consumer passes a category outside the supported
  // enum (stale data, incomplete migration), render the `default` palette
  // instead of throwing — the icon still appears, just in the neutral colour.
  const palette = CATEGORY_STYLES[category] ?? CATEGORY_STYLES.default;
  const tier = variant ?? type ?? "library";
  const isLibrary = tier === "library";

  const backgroundColor = isLibrary
    ? palette.iconBackground.library
    : palette.iconBackground.canvas;
  const color = palette.iconColor;
  return (
    <div
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-[4px]",
        className,
      )}
      style={{ backgroundColor, color }}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="flex size-4 items-center justify-center [&>svg]:size-4"
        >
          {icon}
        </span>
      ) : null}
    </div>
  );
}
