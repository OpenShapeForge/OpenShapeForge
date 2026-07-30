// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared chrome for field-shaped controls (text inputs, select triggers,
 * popover triggers): border, padding, typography, focus/hover/error states.
 *
 * Token-aligned with the Figma `InputHorizontal` component (Battery design
 * system). States not present in the Figma (focus/error/disabled/hover) are
 * derived from the project's existing tailwind v4 + shadcn tokens.
 */
export const fieldShellClasses =
  "border-input bg-card text-foreground-subtle hover:border-foreground/20 rounded-[var(--radius-field)] border px-2 py-[6px] text-[13px] leading-[22px] tracking-[-.39px] outline-none transition-[border-color,box-shadow,background-color,color] focus-ring aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted/55 disabled:text-muted-foreground disabled:opacity-100 read-only:bg-muted/35 read-only:text-foreground/80";
