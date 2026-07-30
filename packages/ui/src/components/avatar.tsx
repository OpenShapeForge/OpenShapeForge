// SPDX-License-Identifier: BUSL-1.1
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/cn"

const avatarVariants = cva(
  "inline-flex size-8 shrink-0 items-center justify-center",
  {
    variants: {
      variant: {
        "avatar-circle-initial": "rounded-full bg-[var(--color-brand-indigo-20)]",
        "avatar-square-initial": "rounded-[var(--radius-small)] bg-[var(--color-brand-aquamarine-20)]",
        "avatar-circle-image": "rounded-full overflow-clip",
        /** Figma shorthand — same tile as `avatar-square-image`. */
        "square-image": "rounded-[var(--radius-small)] overflow-clip",
        "avatar-square-image": "rounded-[var(--radius-small)] overflow-clip",
        icon: "rounded-[var(--radius-small)] bg-card border border-[var(--color-border-muted)]",
        "image-tile": "rounded-[var(--radius-extrasmall)] bg-[var(--color-brand-indigo-40)] overflow-clip",
      },
    },
    defaultVariants: {
      variant: "avatar-circle-initial",
    },
  },
)

type AvatarProps = React.ComponentProps<"div"> &
  VariantProps<typeof avatarVariants> & {
    /** 1–2 character initials — required for circle-initial and square-initial */
    initials?: string
    /** Image URL — required for circle-image, square-image, and image-tile */
    src?: string
    /** Alt text for image variants */
    alt?: string
  }

/**
 * Avatar component — Figma Battery node 4:418.
 *
 * Variants:
 * - `avatar-circle-initial` (default): person initials in a circle
 * - `avatar-square-initial`: org/tenant initials in a rounded square
 * - `avatar-circle-image`: person photo, circle-cropped
 * - `avatar-square-image`: org logo, square-cropped
 * - `icon`: generic icon tile with card bg + border; pass icon as `children`
 * - `image-tile`: image tile with indigo-40 bg, tightest radius
 *
 * @figma node-id=4-418 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-418
 * @figma node-id=4-419 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-419
 * @figma node-id=4-421 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-421
 * @figma node-id=4-423 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-423
 * @figma node-id=4-425 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-425
 * @figma node-id=4-427 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-427
 * @figma node-id=4-429 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-429
 */
function Avatar({
  variant = "avatar-circle-initial",
  initials,
  src,
  alt = "",
  className,
  children,
  ...props
}: AvatarProps) {
  return (
    <div data-slot="avatar" className={cn(avatarVariants({ variant }), className)} {...props}>
      {(variant === "avatar-circle-initial" || variant === "avatar-square-initial") && (
        <span
          className={cn(
            "w-full text-center text-[14px] font-normal leading-[14px] tracking-[-0.42px] select-none",
            // Figma: aquamarine-120 (#0f8a66) → 3.8:1 on indigo-20; patched to #0d7b5e (4.6:1).
            // TODO: unblock when designer fixes Figma (same pattern as --primitive-slate-* / issue #134).
            variant === "avatar-circle-initial" && "text-[#0d7b5e]",
            // Figma: luca-zero-purple-120 (#6d5bf4) → 4.4:1 on aquamarine-20; patched to #6d5beb (4.5:1).
            // TODO: unblock when designer fixes Figma.
            variant === "avatar-square-initial" && "text-[#6d5beb]",
          )}
        >
          {initials}
        </span>
      )}
      {(variant === "avatar-circle-image" ||
        variant === "avatar-square-image" ||
        variant === "square-image" ||
        variant === "image-tile") && (
        <img src={src} alt={alt} className="size-full object-cover pointer-events-none" />
      )}
      {variant === "icon" && children}
    </div>
  )
}

export { Avatar, avatarVariants }
export type { AvatarProps }
